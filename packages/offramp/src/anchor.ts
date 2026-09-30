import { Asset, Horizon, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { NOOP_LOGGER, OffRampJobNotFoundError, type Logger, type PrefillConsent } from "@checkout/core";
import type {
  AnchorCustomer,
  AssetRef,
  OffRampInitiation,
  OffRampJob,
  OffRampJobStatus,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  PayoutFieldDescriptor,
  SellerPayoutRef,
} from "@checkout/core";
import { getSep38Quote } from "./sep38";
import { pickPrefill } from "./sep9";
import { Sep24Client, type Sep24Transaction } from "./sep24";

/**
 * Where the SEP-24 adapter reads a seller's identity and their consent to
 * share it (issue 3.17). Injected rather than imported so this package stays
 * free of any database, and so a caller that has neither (no KYC on file, no
 * anchor consent) simply sends no SEP-9 fields at all.
 */
export interface PrefillSource {
  /**
   * The seller's stored SEP-9 values, or null when nothing is on file. Values
   * are PII: they are never logged, and only the field NAMES ever are.
   */
  loadProfile(sellerId: string): Promise<Record<string, string> | null>;
  /** The seller's consent for `anchorDomain`, or null when none was granted. */
  loadConsent(sellerId: string, anchorDomain: string): Promise<PrefillConsent | null>;
}

export interface AnchorOptions {
  homeDomain: string;
  sellerKeypair: Keypair;
  horizonUrl?: string;
  /** Absent = never pre-fill. See {@link PrefillSource}. */
  prefill?: PrefillSource;
  /**
   * Passphrase of the network the send-leg transaction is signed for.
   *
   * Required, and deliberately not inferred. This used to be derived with
   * `horizonUrl.includes("public")`, which gets mainnet exactly backwards:
   * the pubnet endpoint is `https://horizon.stellar.org` and contains no
   * "public" at all, so a mainnet deployment would have signed every
   * withdrawal with the TESTNET passphrase. Use `Networks.PUBLIC` /
   * `Networks.TESTNET` from @stellar/stellar-sdk.
   */
  networkPassphrase: string;
}

interface StoredQuote {
  sellAsset: AssetRef;
  sellAmount: string;
  buyCurrency: string;
  price: string;
}

interface StoredJob {
  linkId: string;
  /** Asset the withdrawal was quoted in — the send leg must pay this, not XLM. */
  sellAsset: AssetRef;
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  sendTxHash?: string;
  sending?: boolean;
}

export function mapSep24Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  // pending_user_transfer_start, pending_anchor, pending_external, pending_user_info_required, incomplete
  return "pending";
}

/**
 * SEP-24 (interactive) off-ramp.
 *
 * DELIBERATELY NOT EXPORTED from `index.ts`, and not selectable via `OFFRAMP`.
 * `TestAnchorOffRamp` (SEP-6) is the adapter wired into the container for both
 * `OFFRAMP=testanchor` and `OFFRAMP=anchor`.
 *
 * The blocker is state durability, not protocol support: quotes and jobs here
 * live in in-process `Map`s, while the SEP-6 adapter persists both through
 * `OffRampStateRepository`. On a restart mid-withdrawal this loses `sendTxHash`,
 * and money-adjacent state that does not survive a redeploy has no business on
 * pubnet. Port it onto `OffRampStateRepository` before exporting it.
 */
export class AnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly homeDomain: string;
  private readonly sellerKeypair: Keypair;
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly prefillSource: PrefillSource | null;
  private readonly sep24: Sep24Client;
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly jobs = new Map<string, StoredJob>();

  constructor(opts: AnchorOptions) {
    this.homeDomain = opts.homeDomain;
    this.sellerKeypair = opts.sellerKeypair;
    this.horizonUrl = opts.horizonUrl || "https://horizon-testnet.stellar.org";
    this.networkPassphrase = opts.networkPassphrase;
    this.prefillSource = opts.prefill ?? null;
    this.sep24 = new Sep24Client(opts.sellerKeypair, opts.homeDomain);
  }

  /**
   * SEP-24 is interactive — the anchor's own hosted UI collects payout details
   * directly from the seller during `initiate()`, so there are no descriptors
   * to fetch up front (issue #32).
   */
  async offrampRequirements(): Promise<PayoutFieldDescriptor[]> {
    return [];
  }

  async quote(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    const discovery = await this.sep24.getDiscoveryInfo();
    const token = await this.sep24["getAuthToken"]();

    const q = await getSep38Quote(discovery.anchorQuoteServer, token, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
    });

    this.quotes.set(q.id, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
    });

    // Gross is what sourceAmount converts to at the quoted rate; buyAmount is
    // what the anchor actually pays out — the difference is its fee (issue 1.5).
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
      expiresAt: Date.parse(q.expiresAt),
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "anchor" },
      netTargetAmount,
    };
  }

  async initiate(
    input: {
      linkId: string;
      quoteId: string;
      payout: SellerPayoutRef;
      customer: AnchorCustomer;
    },
    opts?: { logger?: Logger },
  ): Promise<OffRampInitiation> {
    const q = this.quotes.get(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const prefill = await this.resolvePrefill(input.customer.sellerId, opts?.logger ?? NOOP_LOGGER);

    const interactiveResult = await this.sep24.startInteractiveWithdraw({
      assetCode: q.sellAsset.code,
      assetIssuer: q.sellAsset.issuer || undefined,
      amount: q.sellAmount,
      account: this.sellerKeypair.publicKey(),
      quoteId: input.quoteId,
      prefill,
    });

    this.jobs.set(interactiveResult.id, {
      linkId: input.linkId,
      sellAsset: q.sellAsset,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
    });

    return {
      kind: "interactive",
      jobId: interactiveResult.id,
      url: interactiveResult.url,
    };
  }

  /**
   * The SEP-9 fields to pre-fill this anchor's hosted form with, or `undefined`
   * for "send none" (issue 3.17).
   *
   * The order of the gates is the point. Consent is read FIRST: a seller with a
   * full profile on file who never consented must produce no SEP-9 keys at all,
   * not "the allowlisted subset that happens to be harmless". Only then is the
   * profile intersected with that consent through the allowlist.
   *
   * `undefined` rather than `{}` on purpose — it keeps the key off the request
   * body entirely instead of serialising an empty object into it.
   *
   * The log event records field NAMES only. A log line is not a place a seller's
   * first name or bank account number belongs, and `logger-redaction.test.ts`
   * treats these as the fields it would catch.
   */
  private async resolvePrefill(sellerId: string, logger: Logger): Promise<Record<string, string> | undefined> {
    const source = this.prefillSource;
    if (!source) {
      logger.info(
        { event: "anchor.sep24.withdraw.start", anchorDomain: this.homeDomain, prefillFields: [] },
        "SEP-24 interactive withdraw starting (prefill not configured)",
      );
      return undefined;
    }

    let prefill: Record<string, string> = {};
    try {
      const consent = await source.loadConsent(sellerId, this.homeDomain);
      if (consent && consent.fields.length > 0) {
        const profile = await source.loadProfile(sellerId);
        if (profile) prefill = pickPrefill(profile, consent.fields);
      }
    } catch (err) {
      // Prefill is a convenience, never a precondition. A profile read or
      // consent read that fails must not fail a cash-out: the anchor's own form
      // is still there and the seller can type into it. Say so and carry on with
      // no SEP-9 fields.
      logger.warn(
        { event: "anchor.sep24.withdraw.prefill_unavailable", error: err instanceof Error ? err.message : String(err) },
        "could not resolve SEP-9 prefill; sending none",
      );
      prefill = {};
    }

    const fieldNames = Object.keys(prefill);
    logger.info(
      { event: "anchor.sep24.withdraw.start", anchorDomain: this.homeDomain, prefillFields: fieldNames },
      "SEP-24 interactive withdraw starting",
    );
    return fieldNames.length > 0 ? prefill : undefined;
  }

  async status(jobId: string): Promise<OffRampJob> {
    const stored = this.jobs.get(jobId);
    if (!stored) {
      // In-memory only: a restart loses every job. Fabricating a placeholder
      // here (as this used to) is worse than failing — the placeholder has no
      // sellAsset and no sendTxHash, so the send leg below would re-fire and
      // pay the anchor a SECOND time for a withdrawal already funded. Refuse
      // instead, and let the caller treat it as unknown state.
      throw new OffRampJobNotFoundError(jobId);
    }

    const tx: Sep24Transaction = await this.sep24.getTransaction(jobId);

    // Handle Send Leg if anchor is waiting for user transfer
    if (tx.status === "pending_user_transfer_start" && !stored.sendTxHash && !stored.sending && tx.withdrawAnchorAccount && tx.withdrawMemo) {
      stored.sending = true;
      try {
        const hash = await this.sendWithdrawalPayment(
          tx.withdrawAnchorAccount,
          tx.withdrawMemo,
          tx.withdrawMemoType || "text",
          tx.amountIn || "0",
          stored.sellAsset
        );
        stored.sendTxHash = hash;
      } catch (err) {
        console.error("Failed to send on-chain withdrawal payment to anchor:", err);
      } finally {
        stored.sending = false;
      }
    }

    const jobStatus = mapSep24Status(tx.status);

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

  private async sendWithdrawalPayment(
    destination: string,
    memoStr: string,
    memoType: string,
    amount: string,
    sellAsset: AssetRef
  ): Promise<string> {
    const server = new Horizon.Server(this.horizonUrl);
    const account = await server.loadAccount(this.sellerKeypair.publicKey());

    let memo: Memo;
    if (memoType === "id") {
      memo = Memo.id(memoStr);
    } else if (memoType === "hash") {
      memo = Memo.hash(memoStr);
    } else {
      memo = Memo.text(memoStr);
    }

    // The send leg must pay the SAME asset the withdrawal was quoted in.
    // This previously hardcoded `Asset.native()`, which sends XLM no matter
    // what the seller is cashing out — on mainnet that hands the anchor the
    // wrong asset for a USDC withdrawal, and the funds do not come back.
    const asset =
      sellAsset.issuer === null
        ? Asset.native()
        : new Asset(sellAsset.code, sellAsset.issuer);

    const tx = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination,
          asset,
          amount,
        })
      )
      .addMemo(memo)
      .setTimeout(30)
      .build();

    tx.sign(this.sellerKeypair);
    const res = await server.submitTransaction(tx);
    return res.hash;
  }
}
