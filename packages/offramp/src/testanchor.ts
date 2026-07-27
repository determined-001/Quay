import type { Keypair } from "@stellar/stellar-sdk";
import type {
  AssetRef,
  OffRampJob,
  OffRampJobStatus,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  SellerPayoutRef,
} from "@checkout/core";
import { Sep10Client } from "./sep10";
import { getSep38Quote } from "./sep38";
import {
  getSep6Transaction,
  putSep12Customer,
  resolveWithdrawType,
  Sep6ValidationError,
  startSep6Withdraw,
  type Sep6WithdrawTypeInfo,
} from "./sep6";

// ===========================================================================
//  REAL ANCHOR — SEP-10 (auth) -> SEP-38 (quote) -> SEP-6 (withdraw).
// ===========================================================================
// Talks to the public Stellar testnet reference anchor by default. Same
// `OffRampPort` contract as MockAnchorOffRamp, `seller_initiated` mode: the
// seller already holds the stablecoin, this only quotes an FX rate and drives
// a real off-chain withdrawal to local/bank rails via the anchor's SEP-6 flow.
//
// SEP-24 (interactive) was considered instead of SEP-6 and rejected: the port
// is backend-only today (no interactive-redirect concept anywhere upstream of
// this adapter), while SEP-6 is fully field-driven and needs no changes to
// LinkService, the API routes, or the dashboard.

const DEFAULT_BASE_URL = "https://testanchor.stellar.org";
const DEFAULT_HOME_DOMAIN = "testanchor.stellar.org";

export interface TestAnchorOptions {
  /** Seller's Stellar keypair — SEP-10 needs the secret key to sign the auth challenge. */
  sellerKeypair: Keypair;
  baseUrl?: string;
  homeDomain?: string;
  /**
   * Preferred SEP-6 withdrawal type (e.g. "bank_account").
   * If omitted the adapter reads /sep6/info and uses the single enabled type,
   * or fails with the list when the anchor offers more than one.
   * Maps to the OFFRAMP_TYPE env var.
   */
  preferredWithdrawType?: string;
}

function mapSep6Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  return "pending"; // pending_anchor, pending_user_transfer_start, pending_external, ...
}

interface StoredQuote {
  sellAsset: AssetRef;
  sellAmount: string;
  buyCurrency: string;
  price: string;
  /** Resolved SEP-6 withdrawal type (discovered from /sep6/info). */
  withdrawType: string;
  /** Required/optional field descriptors for the resolved type (for the payout form). */
  typeInfo: Sep6WithdrawTypeInfo;
  /** Effective fee_fixed from /sep6/info (0 if not published). */
  feeFixed: number;
  /** Effective fee_percent from /sep6/info (0 if not published). */
  feePercent: number;
}

interface StoredJob {
  linkId: string;
  targetCurrency: string;
  targetAmount: string;
  rate: string;
}

export class TestAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly baseUrl: string;
  private readonly auth: Sep10Client;
  private readonly preferredWithdrawType: string | undefined;
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly jobs = new Map<string, StoredJob>();

  constructor(opts: TestAnchorOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.preferredWithdrawType = opts.preferredWithdrawType;
    this.auth = new Sep10Client(opts.sellerKeypair, {
      baseUrl: this.baseUrl,
      homeDomain: opts.homeDomain ?? DEFAULT_HOME_DOMAIN,
    });
  }

  async quote(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    if (input.sourceAsset.issuer === null) {
      throw new Error(
        'The test anchor only off-ramps USDC — create the link with assetCode "USDC" to cash out.',
      );
    }

    // Validate amount against /sep6/info and discover the withdrawal type.
    // Sep6ValidationError propagates as-is so callers can surface anchor limits.
    const { type: withdrawType, typeInfo, feeFixed, feePercent } = await resolveWithdrawType(
      this.baseUrl,
      input.sourceAsset.code,
      input.sourceAmount,
      this.preferredWithdrawType,
    );

    const jwt = await this.auth.token();
    const q = await getSep38Quote(this.baseUrl, jwt, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      // Use the delivery method matching the resolved withdraw type when the
      // anchor publishes one; fall back to omitting it so the anchor chooses.
      buyDeliveryMethod: withdrawType === "bank_account" ? "WIRE" : undefined,
    });

    this.quotes.set(q.id, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
      withdrawType,
      typeInfo,
      feeFixed,
      feePercent,
    });

    return {
      quoteId: q.id,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: q.buyAmount,
      rate: q.price,
      expiresAt: Date.parse(q.expiresAt),
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampJob> {
    const q = this.quotes.get(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const jwt = await this.auth.token();
    await putSep12Customer(this.baseUrl, jwt, input.payout.fields);

    const withdraw = await startSep6Withdraw(this.baseUrl, jwt, {
      assetCode: q.sellAsset.code,
      amount: q.sellAmount,
      account: this.auth.publicKey,
      // Use the type discovered from /sep6/info — never assume "bank_account".
      type: q.withdrawType,
      dest: input.payout.fields.dest,
      destExtra: input.payout.fields.dest_extra,
    });

    this.jobs.set(withdraw.id, {
      linkId: input.linkId,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
    });

    return {
      jobId: withdraw.id,
      linkId: input.linkId,
      status: "pending",
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
    };
  }

  async status(jobId: string): Promise<OffRampJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Unknown off-ramp job");

    const jwt = await this.auth.token();
    const tx = await getSep6Transaction(this.baseUrl, jwt, jobId);
    const status = mapSep6Status(tx.status);
    if (tx.amountOut) job.targetAmount = tx.amountOut;

    return {
      jobId,
      linkId: job.linkId,
      status,
      targetCurrency: job.targetCurrency,
      targetAmount: job.targetAmount,
      rate: job.rate,
      reason: status === "failed" ? (tx.message ?? "testanchor: withdrawal failed") : undefined,
    };
  }
}
