import type {
  AssetRef,
  OffRampJob,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  SellerPayoutRef,
} from "@checkout/core";

// ===========================================================================
//  MOCK ANCHOR — NOT A REAL OFF-RAMP.
// ===========================================================================
// This exists so the cash-out seam can be wired and demoed end-to-end before a
// licensed anchor relationship exists. It runs in `seller_initiated` mode:
// the seller already holds the stablecoin in their own wallet, and this just
// simulates quoting an FX rate and "paying out" local currency.
//
// To go live, replace this with an adapter that implements the same OffRampPort
// against a real Nigerian anchor's SEP endpoints:
//   quote()    -> SEP-38 POST /quote  (firm rate + expiry; moves in-flight FX risk)
//   initiate() -> SEP-24 interactive withdraw, or SEP-31 send  (start the payout)
//   status()   -> poll the transfer to settlement
//
// Do NOT promote this to `inline` mode without legal review: inline routing means
// value moves through the anchor mid-flight, which is the money-transmission /
// custody box. Keep custody at the edges until that story is real.

interface MockJobState extends OffRampJob {
  createdAt: number;
}

const MOCK_RATES: Record<string, number> = {
  // 1 USDC -> X local units. Illustrative only.
  NGN: 1650,
  KES: 129,
  GHS: 15.5,
};

export interface MockAnchorOptions {
  /** ms before a quote expires (default 5 min). */
  quoteTtlMs?: number;
  /** ms after initiate() before the job flips to "settled" (default 8s, for demo). */
  settleAfterMs?: number;
  /** force every payout to fail, to exercise the retry path. */
  alwaysFail?: boolean;
}

export class MockAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly quotes = new Map<string, OffRampQuote>();
  private readonly jobs = new Map<string, MockJobState>();
  private readonly quoteTtlMs: number;
  private readonly settleAfterMs: number;
  private readonly alwaysFail: boolean;

  constructor(opts: MockAnchorOptions = {}) {
    this.quoteTtlMs = opts.quoteTtlMs ?? 5 * 60_000;
    this.settleAfterMs = opts.settleAfterMs ?? 8_000;
    this.alwaysFail = opts.alwaysFail ?? false;
  }

  async quote(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    const rate = MOCK_RATES[input.targetCurrency];
    if (rate === undefined) {
      throw new Error(`Mock anchor has no rate for ${input.targetCurrency}`);
    }
    const targetAmount = (Number(input.sourceAmount) * rate).toFixed(2);
    const q: OffRampQuote = {
      quoteId: id("quote"),
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount,
      rate: String(rate),
      expiresAt: Date.now() + this.quoteTtlMs,
    };
    this.quotes.set(q.quoteId, q);
    return q;
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampJob> {
    const q = this.quotes.get(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");
    if (Date.now() > q.expiresAt) throw new Error("Quote expired");

    const job: MockJobState = {
      jobId: id("ofr"),
      linkId: input.linkId,
      status: "pending",
      targetCurrency: q.targetCurrency,
      targetAmount: q.targetAmount,
      rate: q.rate,
      createdAt: Date.now(),
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  async status(jobId: string): Promise<OffRampJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Unknown off-ramp job");
    if (job.status === "pending" && Date.now() - job.createdAt >= this.settleAfterMs) {
      job.status = this.alwaysFail ? "failed" : "settled";
      if (job.status === "failed") job.reason = "mock anchor: simulated payout failure";
    }
    return { ...job };
  }
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}
