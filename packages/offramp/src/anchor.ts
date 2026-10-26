import { OffRampJobNotFoundError, OffRampRejectedError, targetPerSourceRate } from "@checkout/core";
import type {
  AnchorCustomer,
  AssetRef,
  OffRampInitiation,
  OffRampJob,
  OffRampJobStatus,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  OfframpRequirementTypes,
  OffRampStateRepository,
  RateSourcePort,
  SellerPayoutRef,
  StoredOffRampQuote,
  WithdrawTransfer,
} from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import type { KycRepository, Logger, PrefillConsentRepository } from "@checkout/core";
import { randomBytes } from "node:crypto";
import { computeIndicativeAmounts } from "./quote-math";
import { getSep38Quote } from "./sep38";
import { requireTransferServerSep24 } from "./sep1";
import { SEP24_JOB_MARKER } from "./select";
import { pickPrefill } from "./sep9";
import type { AnchorDiscovery, SellerAnchorAuth } from "./anchor-session";
import {
  estimateSep24Fee,
  getSep24Info,
  Sep24Client,
  validateSep24Withdraw,
  type Sep24AssetInfo,
  type Sep24Transaction,
} from "./sep24";

export interface Sep24OffRampOptions {
  discovery: AnchorDiscovery;
  /**
   * Per-seller anchor sessions. The seller's own wallet signs the SEP-10 challenge in the browser and
   * only the resulting JWT is kept here; this adapter holds no key and signs nothing.
   */
  auth: SellerAnchorAuth;
  /**
   * Where quotes and jobs live. Required, with no in-memory default: a withdrawal's state has to
   * survive a restart (a mid-withdrawal restart must not lose the quote its transfer is checked against).
   */
  state: OffRampStateRepository;
  /**
   * Optional FX rate for anchors with no SEP-38 quote server. With it, `quote()` returns an
   * indicative quote whose fee is estimated from the anchor's SEP-24 /info; without it, such an
   * anchor is refused rather than quoted from an invented rate. Never consulted when SEP-38 exists.
   */
  rateSource?: RateSourcePort;
  /**
   * Where a SEP-24 form prefill comes from (issue 3.17). Without it nothing is prefilled. Both are
   * needed: the seller's stored values (`kyc`) and what they agreed to share with THIS anchor
   * (`consents`); a field is sent only if it is in both and on the SEP-9 prefill allowlist.
   * `resolveType` is the SEP-12 customer type the stored record is keyed by (issue 3.15), if any.
   */
  prefill?: {
    kyc: KycRepository;
    consents: PrefillConsentRepository;
    resolveType?: (customer: AnchorCustomer) => Promise<string | null>;
    /** Told which field NAMES are about to leave for the anchor (an access-log hook). Never values. */
    audit?: (customer: AnchorCustomer, fields: readonly string[]) => Promise<void>;
  };
  /** Receives field NAMES only; no seller value is ever logged. */
  logger?: Logger;
}

const MEMO_TYPES = ["text", "id", "hash"] as const;

function transferMemoType(raw: string | undefined): WithdrawTransfer["memoType"] {
  return (MEMO_TYPES as readonly string[]).includes(raw ?? "") ? (raw as WithdrawTransfer["memoType"]) : null;
}

/**
 * Why a transfer must NOT be offered to the seller, or null when it is safe. Fails closed: this is the
 * instruction the seller's wallet will be asked to send, so anything that cannot be checked against what
 * was quoted is refused rather than guessed.
 */
function refuseTransfer(tx: Sep24Transaction, quote: StoredOffRampQuote | null): string | null {
  if (!quote) {
    return "No stored quote for this withdrawal, so the transfer cannot be checked against what was quoted";
  }
  if (!tx.amountIn) return "Missing amount_in in SEP-24 transaction";
  const amountIn = Number(tx.amountIn);
  if (!Number.isFinite(amountIn) || amountIn <= 0) {
    return `Invalid amount_in ${JSON.stringify(tx.amountIn)} in SEP-24 transaction`;
  }
  if (amountIn > Number(quote.sellAmount)) {
    return `Transfer amount ${tx.amountIn} exceeds quoted amount ${quote.sellAmount}`;
  }
  if (tx.withdrawMemo && tx.withdrawMemoType && transferMemoType(tx.withdrawMemoType) === null) {
    return `Unsupported memo type ${JSON.stringify(tx.withdrawMemoType)} in SEP-24 transaction`;
  }
  return null;
}

export function mapSep24Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  // The anchor is waiting for the SELLER's on-chain payment: distinct from one that already has the
  // money and is paying out (matches the awaiting_transfer status the other adapters report).
  if (status === "pending_user_transfer_start") return "awaiting_transfer";
  // pending_anchor, pending_external, pending_user_info_required, incomplete
  return "pending";
}

/**
 * SEP-24 (interactive) off-ramp.
 *
 * Non-custodial: at `pending_user_transfer_start` it returns the anchor's transfer instructions and the
 * SELLER'S WALLET signs and sends them. Nothing in this adapter signs or submits a payment.
 *
 * Authenticates per seller, exactly like `TestAnchorOffRamp`: every call runs with the JWT of the seller's own
 * session (`SellerAnchorAuth`), never a server-held key (issue #207; `pnpm check:no-server-signing` enforces it).
 *
 * Chosen over `TestAnchorOffRamp` (SEP-6) per anchor by `SelectingOffRamp` from `OFFRAMP_PROTOCOL` and the
 * anchor's SEP-1 declaration (issue 3.19). See docs/decisions/0001-sep6-vs-sep24.md for the protocol comparison.
 */
export class AnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly homeDomain: string;
  private readonly auth: SellerAnchorAuth;
  private readonly sep24: Sep24Client;
  private readonly state: OffRampStateRepository;
  private readonly rateSource: RateSourcePort | undefined;
  private readonly prefill: Sep24OffRampOptions["prefill"];
  private readonly logger: Logger;

  constructor(opts: Sep24OffRampOptions) {
    this.homeDomain = opts.discovery.homeDomain;
    this.auth = opts.auth;
    if (!opts.state) {
      throw new Error("AnchorOffRamp needs an OffRampStateRepository: withdrawal state must survive a restart");
    }
    this.state = opts.state;
    this.rateSource = opts.rateSource;
    this.prefill = opts.prefill;
    this.logger = (opts.logger ?? NOOP_LOGGER).child({ component: "offramp.sep24", anchor: this.homeDomain });
    this.sep24 = new Sep24Client(opts.discovery, this.logger);
  }

  /**
   * The SEP-9 values the seller agreed to share with this anchor, for its form to open pre-filled.
   * No consent (or no source configured) means nothing is sent. A read failure also means nothing is
   * sent: prefill is a convenience, so it fails closed instead of failing the withdrawal.
   */
  private async prefillFor(customer: AnchorCustomer): Promise<Record<string, string>> {
    if (!this.prefill) return {};
    try {
      const consent = await this.prefill.consents.get(customer.sellerId, this.homeDomain);
      if (!consent || consent.fields.length === 0) return {};
      const type = (await this.prefill.resolveType?.(customer)) ?? null;
      const record = await this.prefill.kyc.get(customer.sellerId, this.homeDomain, type);
      if (!record) return {};
      const picked = pickPrefill(record.providedFields, consent.fields);
      const names = Object.keys(picked);
      if (names.length > 0) await this.prefill.audit?.(customer, names.sort());
      return picked;
    } catch (err) {
      this.logger.warn(
        { event: "anchor.sep24.prefill.skipped", error: err instanceof Error ? err.name : "error" },
        "could not load SEP-9 prefill; starting the withdrawal without it",
      );
      return {};
    }
  }

  /**
   * SEP-24 is interactive — the anchor's own hosted UI collects payout details
   * (and any rail choice) directly from the seller during `initiate()`, so
   * there are no descriptors and no types to pick up front (issues #32, 5.24).
   */
  async offrampRequirements(): Promise<OfframpRequirementTypes> {
    return { types: [], defaultType: null };
  }

  async quote(input: {
    linkId?: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
    customer: AnchorCustomer;
  }): Promise<OffRampQuote> {
    const discovery = await this.sep24.getDiscoveryInfo();

    // The anchor's published limits come first: an amount it will refuse is rejected here (422
    // offramp_rejected, carrying the limits) before a session is opened or a SEP-38 quote burned.
    const assetInfo = validateSep24Withdraw(
      await getSep24Info(requireTransferServerSep24(discovery)),
      input.sourceAsset.code,
      input.sourceAmount,
    );

    // No SEP-38, no firm quote: fall back to an indicative one from the rate source, with the fee
    // estimated from /info. No rate source configured means refuse, not guess.
    if (!discovery.anchorQuoteServer) {
      return this.indicativeQuote(input, assetInfo, discovery.homeDomain);
    }

    const token = await this.auth.token(input.customer);

    const q = await getSep38Quote(discovery.anchorQuoteServer, token, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      // A SEP-24 withdrawal can only spend a quote minted for the SEP-24
      // context; the SEP-6 default would be rejected by the anchor.
      context: "sep24",
    });

    const expiresAt = Date.parse(q.expiresAt);
    const now = Date.now();

    // Gross is what sourceAmount converts to at the quoted rate; buyAmount is
    // what the anchor actually pays out — the difference is its fee (issue 1.5).
    const grossTargetAmount = (Number(input.sourceAmount) / Number(q.price)).toFixed(4);
    const netTargetAmount = q.buyAmount;
    const feeAmount = (Number(grossTargetAmount) - Number(netTargetAmount)).toFixed(4);

    await this.state.saveQuote({
      quoteId: q.id,
      linkId: input.linkId ?? "",
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
      // What the seller is about to be shown, so a confirm-by-quoteId replays it.
      quotedAmounts: {
        rate: targetPerSourceRate(q.price),
        targetAmount: grossTargetAmount,
        feeAmount,
        feeSource: "anchor",
        netTargetAmount,
        quoteKind: "firm",
      },
      expiresAt,
      createdAt: now,
    });

    return {
      quoteId: q.id,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: grossTargetAmount,
      // TARGET per source (issue 5.21) — SEP-38's price inverted; the raw
      // price stays on the stored quote above.
      rate: targetPerSourceRate(q.price),
      expiresAt,
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "anchor" },
      netTargetAmount,
      quoteKind: "firm",
    };
  }

  /**
   * Indicative quote for an anchor with no SEP-38: the configured rate source's rate, and a fee
   * estimated from /info (`max(fee_minimum, fee_fixed + amount * fee_percent / 100)` in the sell
   * asset, converted at the same rate). Exact decimal math; the net rounds down so it is never
   * overstated. When /info publishes no fee fields the fee is unknown, and an unknown fee is not a
   * zero fee, so this refuses rather than show a net that may be too high.
   */
  private async indicativeQuote(
    input: { linkId?: string; sourceAsset: AssetRef; sourceAmount: string; targetCurrency: string },
    asset: Sep24AssetInfo,
    anchorDomain: string,
  ): Promise<OffRampQuote> {
    if (!this.rateSource) {
      throw new Error(
        `Anchor ${anchorDomain} declares no ANCHOR_QUOTE_SERVER and no rate source is configured ` +
          `(OFFRAMP_RATE_SOURCE). Refusing to quote rather than inventing a rate.`,
      );
    }
    if (estimateSep24Fee(asset, input.sourceAmount) === null) {
      throw new Error(
        `Anchor ${anchorDomain} publishes no fee for ${input.sourceAsset.code} in /sep24/info and has no SEP-38 quote ` +
          `server, so the payout cannot be estimated without risking an overstated amount.`,
      );
    }

    const fx = await this.rateSource.rate({
      anchorDomain,
      sourceAsset: input.sourceAsset,
      targetCurrency: input.targetCurrency,
    });
    const amounts = computeIndicativeAmounts({
      amount: input.sourceAmount,
      rate: fx.rate,
      feeFixed: asset.feeFixed,
      feePercent: asset.feePercent,
      feeMinimum: asset.feeMinimum,
    });
    if (!amounts.ok) {
      // Never the rate or the fee schedule in the message: it reaches the client.
      throw new OffRampRejectedError(
        amounts.reason === "non_positive_net"
          ? "The anchor's fees are at least as large as this amount, so nothing would be paid out. Try a larger amount."
          : "This amount is too small to produce a payout at the current rate. Try a larger amount.",
      );
    }
    const { targetAmount, feeAmount, netTargetAmount } = amounts;

    // Locally generated: initiate() never sends it to the anchor, where it would mean nothing.
    const quoteId = `q_${randomBytes(10).toString("hex")}`;
    await this.state.saveQuote({
      quoteId,
      linkId: input.linkId ?? "",
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      // Source per target, as on the SEP-38 path.
      price: String(1 / Number(fx.rate)),
      quotedAmounts: {
        rate: fx.rate,
        targetAmount,
        feeAmount,
        feeSource: "estimated",
        netTargetAmount,
        quoteKind: "indicative",
      },
      expiresAt: fx.expiresAt,
      createdAt: Date.now(),
    });

    return {
      quoteId,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount,
      rate: fx.rate,
      expiresAt: fx.expiresAt,
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "estimated" },
      netTargetAmount,
      quoteKind: "indicative",
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
    customer: AnchorCustomer;
  }): Promise<OffRampInitiation> {
    const q = await this.state.getQuote(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const interactiveResult = await this.sep24.startInteractiveWithdraw(await this.auth.token(input.customer), {
      assetCode: q.sellAsset.code,
      assetIssuer: q.sellAsset.issuer || undefined,
      amount: q.sellAmount,
      account: input.customer.account,
      // An indicative quote id is local; the anchor never issued it.
      quoteId: q.quotedAmounts?.quoteKind === "indicative" ? undefined : input.quoteId,
      prefill: await this.prefillFor(input.customer),
    });

    const now = Date.now();
    await this.state.saveJob({
      jobId: interactiveResult.id,
      linkId: input.linkId,
      // Suffixed so telemetry and the poller can tell a SEP-24 job from a
      // SEP-6 one at the same anchor (issue 3.16).
      anchor: `${this.homeDomain}${SEP24_JOB_MARKER}`,
      sellerId: input.customer.sellerId,
      account: input.customer.account,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: targetPerSourceRate(q.price),
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: null,
      transfer: null,
      createdAt: now,
      updatedAt: now,
    });

    // Save quote indexed by jobId as well for status() lookup
    await this.state.saveQuote({
      ...q,
      quoteId: interactiveResult.id,
    });

    return {
      kind: "interactive",
      jobId: interactiveResult.id,
      url: interactiveResult.url,
    };
  }

  async status(jobId: string): Promise<OffRampJob> {
    const stored = await this.state.getJob(jobId);
    if (!stored) {
      throw new OffRampJobNotFoundError(jobId);
    }

    // A job with no seller ran under the old shared platform account; no seller's session can read it.
    if (!stored.sellerId || !stored.account) throw new OffRampJobNotFoundError(jobId);

    const token = await this.auth.token({ sellerId: stored.sellerId, account: stored.account });
    const tx: Sep24Transaction = await this.sep24.getTransaction(token, jobId);
    const jobStatus = mapSep24Status(tx.status);

    if (tx.status === "pending_user_transfer_start" && tx.withdrawAnchorAccount) {
      const quote = await this.state.getQuote(jobId);
      const refusal = refuseTransfer(tx, quote);
      if (refusal || !quote) {
        const reason = refusal ?? "No stored quote for this withdrawal";
        await this.state.updateJob(jobId, {
          status: "failed",
          lastError: reason,
          externalStatus: tx.status,
          transfer: null,
        });
        return {
          jobId: tx.id,
          linkId: stored.linkId,
          status: "failed",
          targetCurrency: stored.targetCurrency,
          targetAmount: tx.amountOut || stored.targetAmount,
          rate: stored.rate,
          reason,
        };
      }

      const transfer: WithdrawTransfer = {
        destination: tx.withdrawAnchorAccount,
        amount: tx.amountIn!, // checked by refuseTransfer above
        asset: quote.sellAsset, // exactly what was quoted, never a guess
        memo: tx.withdrawMemo ?? null,
        memoType: transferMemoType(tx.withdrawMemoType),
      };

      await this.state.updateJob(jobId, {
        targetAmount: tx.amountOut || stored.targetAmount,
        status: "awaiting_transfer",
        externalStatus: tx.status,
        transfer,
      });

      return {
        jobId: tx.id,
        linkId: stored.linkId,
        status: "awaiting_transfer",
        targetCurrency: stored.targetCurrency,
        targetAmount: tx.amountOut || stored.targetAmount,
        rate: stored.rate,
        reason: tx.message,
        transfer,
      };
    }

    if (stored.transfer) {
      await this.state.updateJob(jobId, {
        targetAmount: tx.amountOut || stored.targetAmount,
        status: jobStatus,
        externalStatus: tx.status,
        lastError: jobStatus === "failed" ? (tx.message ?? null) : null,
        transfer: null,
      });
    } else {
      await this.state.updateJob(jobId, {
        targetAmount: tx.amountOut || stored.targetAmount,
        status: jobStatus,
        externalStatus: tx.status,
        lastError: jobStatus === "failed" ? (tx.message ?? null) : null,
      });
    }

    return {
      jobId: tx.id,
      linkId: stored.linkId,
      status: jobStatus,
      targetCurrency: stored.targetCurrency,
      targetAmount: tx.amountOut || stored.targetAmount,
      rate: stored.rate,
      reason: tx.message,
    };
  }
}
