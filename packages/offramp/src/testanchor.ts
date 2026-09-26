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
  type SellerPayoutRef,
  type WithdrawTypeRequirements,
} from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import type { AnchorDiscovery, SellerAnchorAuth } from "./anchor-session";
import { listsCurrency, type Sep1DiscoveryInfo } from "./sep1";
import { getSep38Prices, getSep38Quote } from "./sep38";
import { getSep6Info, getSep6Transaction, resolveWithdrawType, startSep6Withdraw } from "./sep6";

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
// SEP-24 (interactive) was considered instead of SEP-6 and rejected: the port
// is backend-only today (no interactive-redirect concept anywhere upstream of
// this adapter), while SEP-6 is fully field-driven and needs no changes to
// LinkService, the API routes, or the dashboard.
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
   */
  async indicativePrices(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
  }): Promise<IndicativePrice[]> {
    const d = await this.discover();
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
      rate: q.price,
      expiresAt,
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "anchor" },
      netTargetAmount,
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
      rate: q.price,
      status: "pending",
      externalStatus: null,
      lastError: null,
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
