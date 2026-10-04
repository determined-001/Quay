import type { Keypair } from "@stellar/stellar-sdk";
import { OffRampJobNotFoundError, targetPerSourceRate } from "@checkout/core";
import type {
  AssetRef,
  OffRampInitiation,
  OffRampJob,
  OffRampJobStatus,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  OfframpRequirementTypes,
  OffRampStateRepository,
  SellerPayoutRef,
  StoredOffRampQuote,
  WithdrawTransfer,
} from "@checkout/core";
import { getSep38Quote } from "./sep38";
import { Sep24Client, type Sep24Transaction } from "./sep24";

export interface AnchorOptions {
  homeDomain: string;
  /** Used only to authenticate to the anchor (SEP-10). It never signs a payment. */
  sellerKeypair: Keypair;
  /**
   * Where quotes and jobs live. Required, with no in-memory default: a withdrawal's state has to
   * survive a restart (a mid-withdrawal restart must not lose the quote its transfer is checked against).
   */
  state: OffRampStateRepository;
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
 * Still NOT exported from `index.ts` and not selectable via `OFFRAMP`: `TestAnchorOffRamp` (SEP-6) is the
 * adapter wired into the container. Quotes and jobs now live in the injected `OffRampStateRepository`, which
 * is required, so the old blocker (in-process state lost on restart) is gone. What remains before it could be
 * exported is that it still authenticates to the anchor with one platform keypair instead of per-seller
 * SEP-10 sessions like `TestAnchorOffRamp`.
 */
export class AnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly homeDomain: string;
  private readonly sellerKeypair: Keypair;
  private readonly sep24: Sep24Client;
  private readonly state: OffRampStateRepository;

  constructor(opts: AnchorOptions) {
    this.homeDomain = opts.homeDomain;
    this.sellerKeypair = opts.sellerKeypair;
    if (!opts.state) {
      throw new Error("AnchorOffRamp needs an OffRampStateRepository: withdrawal state must survive a restart");
    }
    this.state = opts.state;
    this.sep24 = new Sep24Client(opts.sellerKeypair, opts.homeDomain);
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
  }): Promise<OffRampQuote> {
    const discovery = await this.sep24.getDiscoveryInfo();
    const token = await this.sep24["getAuthToken"]();

    const q = await getSep38Quote(discovery.anchorQuoteServer, token, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
    });

    const expiresAt = Date.parse(q.expiresAt);
    const now = Date.now();

    await this.state.saveQuote({
      quoteId: q.id,
      linkId: input.linkId ?? "",
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
      expiresAt,
      createdAt: now,
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
      // TARGET per source (issue 5.21) — SEP-38's price inverted; the raw
      // price stays on the stored quote above.
      rate: targetPerSourceRate(q.price),
      expiresAt,
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "anchor" },
      netTargetAmount,
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampInitiation> {
    const q = await this.state.getQuote(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const interactiveResult = await this.sep24.startInteractiveWithdraw({
      assetCode: q.sellAsset.code,
      assetIssuer: q.sellAsset.issuer || undefined,
      amount: q.sellAmount,
      account: this.sellerKeypair.publicKey(),
      quoteId: input.quoteId,
      payoutFields: input.payout.fields,
    });

    const now = Date.now();
    await this.state.saveJob({
      jobId: interactiveResult.id,
      linkId: input.linkId,
      anchor: this.homeDomain,
      // Authenticated with the platform keypair, not a seller's own SEP-10 session.
      sellerId: null,
      account: null,
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

    const tx: Sep24Transaction = await this.sep24.getTransaction(jobId);
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
