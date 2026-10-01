import {
  OffRampJobNotFoundError,
  type AnchorCustomer,
  type AssetRef,
  type Logger,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampJobStatus,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type IndicativePrice,
  type OffRampStateRepository,
  type OfframpRequirementTypes,
  type RateSourcePort,
  type SellerPayoutRef,
  type WithdrawTypeRequirements,
} from "@checkout/core";
import { NOOP_LOGGER, targetPerSourceRate } from "@checkout/core";
import type { AnchorDiscovery, SellerAnchorAuth } from "./anchor-session";
import { listsCurrency, type Sep1DiscoveryInfo } from "./sep1";
import { getSep38Prices, getSep38Quote } from "./sep38";
import { getSep6Info, getSep6Transaction, resolveWithdrawType, startSep6Withdraw } from "./sep6";
import { randomBytes } from "node:crypto";

/**
 * A local quote id for the no-SEP-38 path (issue 3.22). `apps/api` owns the
 * shared `newId` helper, and this package deliberately does not depend on it, so
 * the id shape is reproduced here rather than reaching across the workspace.
 */
function newQuoteId(): string {
  return `q_${randomBytes(10).toString("hex")}`;
}

// ===========================================================================
//  REAL ANCHOR — SEP-10 (auth) -> SEP-38 (quote) -> SEP-6 (withdraw).
// ===========================================================================
// Despite the name, nothing here is testnet-specific: the SEP-10/38/6 flow is
// identical against a production anchor. Only the DEFAULT_ constants point at
// the testnet reference sandbox, and both are overridable (`baseUrl` /
// `homeDomain`, wired to ANCHOR_URL / ANCHOR_HOME_DOMAIN). `OFFRAMP=anchor`
// supplies a real anchor; `OFFRAMP=testanchor` is that same adapter with the
// sandbox defaults filled in.
//
// Talks to the public Stellar testnet reference anchor by default. Same
// `OffRampPort` contract as MockAnchorOffRamp, `seller_initiated` mode: the
// seller already holds the stablecoin, this only quotes an FX rate and drives
// a real off-chain withdrawal to local/bank rails via the anchor's SEP-6 flow.
//
// SEP-6 vs SEP-24: both are supported; see docs/decisions/0001-sep6-vs-sep24.md.
//
// Quotes and jobs are persisted through `OffRampStateRepository` rather than
// kept in a Map — this is money-adjacent state that must survive a restart.
//
// SEP-12 KYC is deliberately NOT done here: `TestAnchorKyc` (kyc.ts) owns that
// lifecycle, keyed by seller and submitted ahead of time through /seller/kyc.
// `initiate()` assumes the caller (LinkService) already confirmed the seller's
// KYC status is ACCEPTED — this adapter has no business fabricating identity
// fields from whatever happened to be in a cash-out request.
//
// Every authenticated call runs as the SELLER: `SellerAnchorAuth` holds the
// JWT the anchor issued to the seller's own wallet. There is no platform key
// here, and the on-chain leg of a withdrawal is returned to the seller to sign
// (`kind: "transfer"`) rather than sent from anything Quay controls.

/** The public SDF testnet reference anchor — the `OFFRAMP=testanchor` preset. */
export const TESTANCHOR_BASE_URL = "https://testanchor.stellar.org";
export const TESTANCHOR_HOME_DOMAIN = "testanchor.stellar.org";

export interface TestAnchorOptions {
  discovery: AnchorDiscovery;
  auth: SellerAnchorAuth;
  state: OffRampStateRepository;
  /**
   * Preferred SEP-6 withdrawal type (e.g. "bank_account").
   * If omitted the adapter reads /sep6/info and uses the single enabled type,
   * or fails with the list when the anchor offers more than one.
   * Maps to the OFFRAMP_TYPE env var.
   */
  preferredWithdrawType?: string;
  /**
   * Where the FX rate comes from when the anchor has no SEP-38 quote server
   * (issue 3.22). Unset and the adapter refuses to quote rather than inventing
   * a rate: an anchor with neither ANCHOR_QUOTE_SERVER nor a configured rate
   * source is a configuration error, not something to paper over.
   */
  rateSource?: RateSourcePort;
  /** Optional logger; if absent, all anchor.* events are dropped (NOOP_LOGGER). */
  logger?: Logger;
}

function mapSep6Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  return "pending"; // pending_anchor, pending_user_transfer_start, pending_external, ...
}

export class TestAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly discovery: AnchorDiscovery;
  private readonly auth: SellerAnchorAuth;
  private readonly homeDomain: string;
  private readonly state: OffRampStateRepository;
  private readonly logger: Logger;
  private readonly rateSource: RateSourcePort | undefined;
  /** Operator's chosen SEP-6 withdraw type; undefined means "infer, and refuse
   *  if the anchor offers more than one". See resolveWithdrawType. */
  private readonly preferredWithdrawType: string | undefined;
  /**
   * Identifies the anchor in persisted job rows and off-ramp telemetry. It is
   * the anchor's home domain, not a build-time constant: with a configurable
   * `baseUrl` the old hardcoded "testanchor" would have labelled every real
   * mainnet payout as sandbox traffic, silently poisoning the corridor stats
   * that `anchorDomain` exists to key.
   */
  private readonly anchorName: string;

  constructor(opts: TestAnchorOptions) {
    this.discovery = opts.discovery;
    this.auth = opts.auth;
    this.homeDomain = opts.discovery.homeDomain;
    this.anchorName = this.homeDomain;
    this.state = opts.state;
    this.preferredWithdrawType = opts.preferredWithdrawType;
    this.logger = (opts.logger ?? NOOP_LOGGER).child({ component: "offramp.anchor", anchor: this.anchorName });
    this.rateSource = opts.rateSource;
  }

  private discover(): Promise<Sep1DiscoveryInfo> {
    return this.discovery.get();
  }

  /**
   * Guard that the anchor actually lists the asset we are about to withdraw.
   * An anchor that declares no [[CURRENCIES]] is not asserting anything, so
   * that case passes.
   */
  private assertListed(d: Sep1DiscoveryInfo, assetCode: string): void {
    if (listsCurrency(d, assetCode)) return;
    throw new Error(
      `Anchor ${this.homeDomain} does not list ${assetCode} in its stellar.toml CURRENCIES ` +
        `(lists: ${d.currencies.join(", ") || "none"})`,
    );
  }

  /**
   * Indicative prices via SEP-38 GET /prices — unauthenticated, no quote consumed.
   * Safe to call on every dashboard load without burning a firm quote (issue 3.5).
   *
   * An anchor with no ANCHOR_QUOTE_SERVER has no indicative prices either, and
   * an empty list is the honest answer: the dashboard shows nothing until a
   * rate source is configured. It must NOT guess `/sep38` and fetch it
   * (issue 3.22) — that request cannot succeed, so it is a wasted round trip to
   * a URL the anchor never published.
   */
  async indicativePrices(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
  }): Promise<IndicativePrice[]> {
    const d = await this.discover();
    if (!d.anchorQuoteServer) return [];
    const entries = await getSep38Prices(d.anchorQuoteServer, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
    });
    return entries.map((e) => ({
      targetCurrency: e.buyCurrency,
      price: e.price,
      deliveryMethods: e.deliveryMethods,
    }));
  }

  /**
   * Every SEP-6 withdrawal type the anchor offers for this asset, with each
   * type's field descriptors read from /info `types[].fields` — the level the
   * spec keeps withdraw fields at (issue 5.24; the old asset-level read meant
   * the form never changed with the rail). `defaultType` preselects the
   * operator's OFFRAMP_TYPE when the anchor actually offers it, or the only
   * type when there is exactly one; otherwise the seller must choose.
   */
  async offrampRequirements(assetCode: string, _customer?: AnchorCustomer): Promise<OfframpRequirementTypes> {
    const d = await this.discover();
    this.assertListed(d, assetCode);
    const info = await getSep6Info(d.transferServer, this.logger);
    const asset = info.withdraw[assetCode];
    if (!asset?.enabled) {
      throw new Error(`SEP-6 anchor does not support withdrawing ${assetCode}`);
    }

    const types: WithdrawTypeRequirements[] = Object.entries(asset.types).map(([name, t]) => ({
      name,
      descriptors: Object.entries(t.fields).map(([fieldName, meta]) => ({
        name: fieldName,
        label: meta.description ?? fieldName, // SEP-6 uses "description" as the human label
        optional: meta.optional ?? false,
        choices: meta.choices,
      })),
    }));

    const defaultType =
      this.preferredWithdrawType && types.some((t) => t.name === this.preferredWithdrawType)
        ? this.preferredWithdrawType
        : types.length === 1
          ? types[0]!.name
          : null;

    return { types, defaultType };
  }

  async quote(
    input: {
      linkId: string;
      sourceAsset: AssetRef;
      sourceAmount: string;
      targetCurrency: string;
      customer: AnchorCustomer;
      withdrawType?: string;
    },
    opts: { logger?: Logger } = {},
  ): Promise<OffRampQuote> {
    if (input.sourceAsset.issuer === null) {
      throw new Error(
        'This anchor only off-ramps USDC — create the link with assetCode "USDC" to cash out.',
      );
    }
    const log = (opts.logger ?? this.logger);

    // Validate amount against /sep6/info and discover the withdrawal type.
    // Sep6ValidationError propagates as-is so callers can surface anchor limits.
    const d = await this.discover();
    this.assertListed(d, input.sourceAsset.code);
    // The seller's choice wins; the operator-wide OFFRAMP_TYPE is only the
    // fallback default (issue 5.24). resolveWithdrawType still rejects a type
    // the anchor does not offer, carrying availableTypes for the 400 upstream.
    const { type: withdrawType, typeInfo, feeFixed, feePercent } = await resolveWithdrawType(
      d.transferServer,
      input.sourceAsset.code,
      input.sourceAmount,
      input.withdrawType ?? this.preferredWithdrawType,
    );

    const jwt = await this.auth.token(input.customer);

    // ─── Which quote path (issue 3.22) ───────────────────────────────────────
    // An anchor either implements SEP-38 or it does not, and there is no third
    // case worth guessing at: this used to call SEP-38 unconditionally, so
    // every quote against an anchor that declares no ANCHOR_QUOTE_SERVER died
    // on a 404 from a URL that anchor never published — and tripped the
    // circuit breaker on the way out.
    if (d.anchorQuoteServer) {
      const q = await getSep38Quote(d.anchorQuoteServer, jwt, {
        sellAsset: input.sourceAsset,
        sellAmount: input.sourceAmount,
        buyCurrency: input.targetCurrency,
        // Use the delivery method matching the resolved withdraw type when the
        // anchor publishes one; fall back to omitting it so the anchor chooses.
        buyDeliveryMethod: withdrawType === "bank_account" ? "WIRE" : undefined,
      }, log);

      const expiresAt = Date.parse(q.expiresAt);
      await this.state.saveQuote({
        quoteId: q.id,
        linkId: input.linkId,
        sellAsset: input.sourceAsset,
        sellAmount: input.sourceAmount,
        buyCurrency: input.targetCurrency,
        price: q.price,
        // Persisted so initiate() withdraws on the rail this price was quoted
        // for, rather than re-deriving it and possibly landing on another.
        withdrawType,
        expiresAt,
        createdAt: Date.now(),
      });

      const grossTargetAmount = (Number(input.sourceAmount) / Number(q.price)).toFixed(4);
      const netTargetAmount = q.buyAmount;
      const feeAmount = (Number(grossTargetAmount) - Number(netTargetAmount)).toFixed(4);

      return {
        quoteId: q.id,
        sourceAsset: input.sourceAsset,
        sourceAmount: input.sourceAmount,
        targetCurrency: input.targetCurrency,
        targetAmount: grossTargetAmount,
        // OffRampQuote.rate is TARGET per source (issue 5.21); SEP-38's price
        // is the inverse. The raw price stays on the stored quote above —
        // this is a unit conversion at the boundary, not a loss of data.
        rate: targetPerSourceRate(q.price),
        expiresAt,
        fee: { amount: feeAmount, currency: input.targetCurrency, source: "anchor" },
        netTargetAmount,
        // The anchor quoted this number, so it is a promise rather than a guess.
        quoteKind: "firm",
      };
    }

    return this.quoteWithoutSep38({ input, withdrawType, feeFixed, feePercent, log });
  }

  /**
   * The no-SEP-38 quote path (issue 3.22).
   *
   * The FX rate comes from a configured {@link RateSourcePort}; the fees come
   * from the anchor's own published /sep6/info, which `resolveWithdrawType`
   * already returned and this adapter previously discarded. The arithmetic:
   *
   *   gross = amount × rate
   *   fee   = (feeFixed + amount × feePercent/100) × rate
   *   net   = gross − fee
   *
   * The fee is published in the SELL asset — that is what /sep6/info's
   * feeFixed/feePercent mean — so it is converted at the same rate rather than
   * added in the target currency. Both the quote and its fee are marked
   * indicative/estimated, because the anchor, not us, decides the final amount.
   */
  private async quoteWithoutSep38(args: {
    input: {
      linkId: string;
      sourceAsset: AssetRef;
      sourceAmount: string;
      targetCurrency: string;
      customer: AnchorCustomer;
    };
    withdrawType: string;
    feeFixed: number | undefined;
    feePercent: number | undefined;
    log: Logger;
  }): Promise<OffRampQuote> {
    const { input, withdrawType, feeFixed, feePercent, log } = args;
    if (!this.rateSource) {
      throw new Error(
        `Anchor ${this.anchorName} declares no ANCHOR_QUOTE_SERVER and no rate source is configured ` +
          `(OFFRAMP_RATE_SOURCE). Refusing to quote rather than inventing a rate.`,
      );
    }

    const fx = await this.rateSource.rate({
      anchorDomain: this.anchorName,
      sourceAsset: input.sourceAsset,
      targetCurrency: input.targetCurrency,
    });
    const rate = Number(fx.rate);
    const amount = Number(input.sourceAmount);

    const gross = amount * rate;
    // Absent fee fields mean no fee, not NaN.
    const feeInSellAsset = (feeFixed ?? 0) + amount * ((feePercent ?? 0) / 100);
    const fee = feeInSellAsset * rate;
    const net = gross - fee;

    // Locally generated: there is no anchor quote id to persist, and initiate()
    // never sends this to the anchor, where it would mean nothing.
    const quoteId = newQuoteId();
    await this.state.saveQuote({
      quoteId,
      linkId: input.linkId,
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      // Persisted in the same units the SEP-38 path uses (source per target) so
      // every existing reader — telemetry, the job row — stays consistent.
      price: String(1 / rate),
      withdrawType,
      expiresAt: fx.expiresAt,
      createdAt: Date.now(),
    });

    log.info(
      {
        event: "anchor.quote.indicative",
        anchor: this.anchorName,
        quoteId,
        rateSource: fx.source,
        rate: fx.rate,
        feeFixed: feeFixed ?? null,
        feePercent: feePercent ?? null,
      },
      "no SEP-38 on this anchor; quoted indicatively from a configured rate source",
    );

    return {
      quoteId,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: gross.toFixed(4),
      rate: String(fx.rate),
      expiresAt: fx.expiresAt,
      fee: { amount: fee.toFixed(4), currency: input.targetCurrency, source: "estimated" },
      netTargetAmount: net.toFixed(4),
      quoteKind: "indicative",
    };
  }

  async initiate(
    input: { linkId: string; quoteId: string; payout: SellerPayoutRef; customer: AnchorCustomer },
    opts: { logger?: Logger } = {},
  ): Promise<OffRampInitiation> {
    const baseLog = opts.logger ?? this.logger;
    const child = baseLog.child({ linkId: input.linkId });
    const q = await this.state.getQuote(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const jwt = await this.auth.token(input.customer);
    const dsc = await this.discover();

    // A quote stored before `withdrawType` existed has none. Re-resolve from
    // /info rather than defaulting to "bank_account" — assuming the rail is
    // exactly what this PR exists to stop doing.
    const withdrawType =
      q.withdrawType ??
      (await resolveWithdrawType(dsc.transferServer, q.sellAsset.code, q.sellAmount, this.preferredWithdrawType, baseLog))
        .type;

    // Deliberately no quote_id here, on both paths (issue 3.22). SEP-6 has no
    // quote_id parameter, and on the no-SEP-38 path the stored quote id is one
    // WE generated — sending it to the anchor would be handing it an id it
    // never issued and never agreed to. What the anchor does quote is the
    // amount and the type, both of which are below.
    const withdraw = await startSep6Withdraw(dsc.transferServer, jwt, {
      assetCode: q.sellAsset.code,
      amount: q.sellAmount,
      account: input.customer.account,
      // The type discovered from /sep6/info at quote time — never assumed.
      type: withdrawType,
      dest: input.payout.fields.dest,
      destExtra: input.payout.fields.dest_extra,
    }, baseLog);

    const now = Date.now();
    await this.state.saveJob({
      jobId: withdraw.id,
      linkId: input.linkId,
      anchor: this.anchorName,
      sellerId: input.customer.sellerId,
      account: input.customer.account,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      // Same direction as OffRampQuote.rate: telemetry falls back to
      // job.rate at settlement, so a sell-per-buy value here would poison
      // the spread exactly the way issue 5.21 describes.
      rate: targetPerSourceRate(q.price),
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    child.info({ event: "anchor.sep6.withdraw.init", withdrawId: withdraw.id, linkId: input.linkId }, "anchor withdraw init");

    // The anchor pays out only after it receives the asset, and only the
    // seller can send it. Hand back exactly what the anchor asked for; when it
    // has not said yet (e.g. review pending) the job simply stays pending.
    if (!withdraw.accountId) return { kind: "fields", jobId: withdraw.id };
    return {
      kind: "transfer",
      jobId: withdraw.id,
      transfer: {
        destination: withdraw.accountId,
        amount: q.sellAmount,
        asset: q.sellAsset,
        memo: withdraw.memo ?? null,
        memoType: withdraw.memoType ?? null,
      },
    };
  }

  async status(jobId: string, opts: { logger?: Logger } = {}): Promise<OffRampJob> {
    const job = await this.state.getJob(jobId);
    if (!job) throw new OffRampJobNotFoundError(jobId);

    // A job written before withdrawals were per seller ran under the old
    // shared platform account. No seller's session can read it, so its state
    // is as unreachable as a lost one.
    if (!job.sellerId || !job.account) throw new OffRampJobNotFoundError(jobId);

    const baseLog = (opts.logger ?? this.logger);
    const child = baseLog.child({ jobId, linkId: job.linkId });
    const jwt = await this.auth.token({ sellerId: job.sellerId, account: job.account });
    const tx = await getSep6Transaction((await this.discover()).transferServer, jwt, jobId, baseLog);
    const status = mapSep6Status(tx.status);
    const targetAmount = tx.amountOut ?? job.targetAmount;
    const reason = status === "failed" ? (tx.message ?? `${this.anchorName}: withdrawal failed`) : null;

    await this.state.updateJob(jobId, {
      targetAmount,
      status,
      externalStatus: tx.status,
      lastError: reason,
    });

    return {
      jobId,
      linkId: job.linkId,
      status,
      targetCurrency: job.targetCurrency,
      targetAmount,
      rate: job.rate,
      reason: reason ?? undefined,
    };
  }
}
