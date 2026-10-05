import type { AssetRef, PaymentLink, StoredOffRampJob, WithdrawTransfer } from "@checkout/core";

/**
 * Reconciliation report (issue 4.32): does every cash-out we started have
 * exactly one matching on-chain transfer, and did the anchor pay out what it
 * quoted?
 *
 * Three independent records are compared per `offramp_jobs` row:
 *   1. Quay's withdrawal: the job and its link's quoted net amount.
 *   2. The seller's on-chain transfer: the hash they CLAIMED (a claim, never
 *      proof) is looked up on Horizon and checked field by field.
 *   3. The anchor's payout: `amount_out` and `stellar_transaction_id` as the
 *      anchor reported them on its SEP-6 transaction.
 *
 * Read-only: it never writes. Output carries link ids, job ids, seller ids and
 * Stellar public keys / hashes only. It never touches anchor tokens, payout
 * (bank) fields, KYC data or raw anchor/Horizon bodies, and it names which
 * field mismatched without echoing the memo value.
 *
 * Money is compared as exact decimals (BigInt at a fixed scale), never as
 * floating point.
 */

export type ReconciliationStatus =
  | "matched"
  | "no_transfer"
  | "transfer_mismatch"
  | "payout_short"
  | "pending"
  // Beyond the issue's five: explicit labels for cases that would otherwise be
  // hidden inside "matched" or "pending", or crash the run.
  | "failed_after_transfer"
  | "status_drift"
  | "unverified";

export type MismatchField =
  | "hash"
  | "tx_failed"
  | "destination"
  | "source"
  | "asset"
  | "amount"
  | "memo"
  | "anchor_tx_id"
  | "duplicate_claim";

export interface HorizonTransaction {
  successful: boolean;
  memoType: string | null;
  memo: string | null;
}

export interface HorizonPayment {
  from: string;
  to: string;
  amount: string;
  asset: AssetRef;
}

/** Narrow Horizon surface the report needs; stubbed in tests. */
export interface HorizonLookup {
  /** null when Horizon answers 404 (no such transaction). Throws on any other failure. */
  getTransaction(hash: string): Promise<HorizonTransaction | null>;
  getPayments(hash: string): Promise<HorizonPayment[]>;
}

export interface ReconciliationItem {
  jobId: string;
  linkId: string;
  sellerId: string | null;
  /** The seller's Stellar public key the transfer should come from. */
  account: string | null;
  anchor: string;
  jobStatus: string;
  anchorStatus: string | null;
  status: ReconciliationStatus;
  /** Which fields differed, when status is transfer_mismatch. */
  mismatchFields: MismatchField[];
  /** Checks that could not be made (e.g. no stored deposit instructions). */
  unchecked: string[];
  /** Human-readable reason; never contains memo values or anchor bodies. */
  detail: string | null;
  sellerTxHash: string | null;
  anchorTxId: string | null;
  sellAsset: string | null;
  expectedTransferAmount: string | null;
  anchorAmountIn: string | null;
  quotedNetAmount: string | null;
  amountOut: string | null;
  targetCurrency: string;
  /** quoted - amount_out, exact decimal; negative means overpaid. */
  shortfall: string | null;
  /** shortfall / quoted as a percentage with 4 decimals, exact (truncated). */
  shortfallPct: string | null;
  createdAt: number;
}

export interface ReconciliationReport {
  from: number;
  to: number;
  tolerancePct: string;
  generatedAt: number;
  total: number;
  counts: Record<ReconciliationStatus, number>;
  items: ReconciliationItem[];
}

export interface ReconciliationDeps {
  jobs: { listJobsCreatedBetween(from: number, to: number): Promise<StoredOffRampJob[]> };
  links: { findById(id: string): Promise<PaymentLink | null> };
  horizon: HorizonLookup;
}

export const DEFAULT_TOLERANCE_PCT = "0.5";

// ---------------------------------------------------------------------------
// Exact decimal arithmetic
// ---------------------------------------------------------------------------

/** Scale (decimal places) all amounts are normalised to. Stellar uses 7; fiat needs fewer. */
const SCALE = 12;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/**
 * Parse a non-negative plain decimal string ("12", "12.50", "0.0000001") into
 * an integer at SCALE places. Returns null for anything else (exponents,
 * signs, empty, more than SCALE places) so a bad value is reported rather than
 * silently rounded or turned into NaN.
 */
export function parseDecimal(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > SCALE) return null;
  return BigInt(m[1]!) * SCALE_FACTOR + BigInt(frac.padEnd(SCALE, "0") || "0");
}

/** Render a SCALE-place integer as a trimmed decimal string (keeps the sign). */
export function formatDecimal(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** a / b as a percentage with 4 decimals, truncated toward zero. b must be > 0. */
function pctOf(a: bigint, b: bigint): string {
  const scaled = (a * 1_000_000n) / b; // percent * 10^4
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  return `${neg ? "-" : ""}${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Per-job check
// ---------------------------------------------------------------------------

const HASH_RE = /^[0-9a-f]{64}$/;

function sameAsset(a: AssetRef, b: AssetRef): boolean {
  if (a.code !== b.code) return false;
  if (a.code === "XLM" && !a.issuer && !b.issuer) return true;
  return (a.issuer ?? null) === (b.issuer ?? null);
}

function assetLabel(a: AssetRef | null | undefined): string | null {
  return a ? a.code : null;
}

const COMPLETED = "completed";

interface Expected {
  transfer: WithdrawTransfer | null;
  asset: AssetRef | null;
  amount: string | null;
}

function expectedTransfer(job: StoredOffRampJob): Expected {
  if (job.transfer) {
    return { transfer: job.transfer, asset: job.transfer.asset, amount: job.transfer.amount };
  }
  return { transfer: null, asset: job.sellAsset ?? null, amount: job.sellAmount ?? null };
}

/**
 * Compare one job against Horizon. `duplicateClaim` is true when another job
 * in the same run claims the same hash.
 */
export async function reconcileJob(
  job: StoredOffRampJob,
  link: PaymentLink | null,
  horizon: HorizonLookup,
  tolerancePct: string,
  duplicateClaim = false,
): Promise<ReconciliationItem> {
  const exp = expectedTransfer(job);
  const sellerTxHash = job.sellerTxHash ? job.sellerTxHash.toLowerCase() : null;
  const anchorTxId = job.stellarTransactionId ? job.stellarTransactionId.toLowerCase() : null;
  const anchorStatus = job.externalStatus ?? null;
  const anchorCompleted = anchorStatus === COMPLETED;
  const quotedNetAmount = link?.offrampNetTargetAmount ?? null;
  const amountOut = job.targetAmount ? job.targetAmount : null;

  const item: ReconciliationItem = {
    jobId: job.jobId,
    linkId: job.linkId,
    sellerId: job.sellerId ?? link?.sellerId ?? null,
    account: job.account,
    anchor: job.anchor,
    jobStatus: job.status,
    anchorStatus,
    status: "pending",
    mismatchFields: [],
    unchecked: [],
    detail: null,
    sellerTxHash,
    anchorTxId,
    sellAsset: assetLabel(exp.asset),
    expectedTransferAmount: exp.amount,
    anchorAmountIn: job.amountIn ?? null,
    quotedNetAmount,
    amountOut: anchorCompleted ? amountOut : null,
    targetCurrency: job.targetCurrency,
    shortfall: null,
    shortfallPct: null,
    createdAt: job.createdAt,
  };

  const done = (status: ReconciliationStatus, detail: string | null): ReconciliationItem => {
    item.status = status;
    item.detail = detail;
    return item;
  };

  // 1. No claimed hash.
  if (!sellerTxHash) {
    if (anchorCompleted || job.status === "settled") {
      return done(
        "no_transfer",
        anchorTxId
          ? "anchor completed this withdrawal and cites an on-chain transaction, but the seller never reported a transfer hash"
          : "anchor completed this withdrawal but no transfer hash was ever reported and the anchor cites no transaction",
      );
    }
    if (job.status === "failed") {
      return done("no_transfer", "withdrawal failed and no transfer was reported; no funds are expected to have moved");
    }
    return done("pending", "awaiting the seller's transfer to the anchor");
  }

  // 2. A claimed hash: verify it on Horizon.
  if (!HASH_RE.test(sellerTxHash)) {
    item.mismatchFields.push("hash");
    return done("transfer_mismatch", "claimed hash is not a valid 64-character hex transaction hash");
  }

  let tx: HorizonTransaction | null;
  let payments: HorizonPayment[] = [];
  try {
    tx = await horizon.getTransaction(sellerTxHash);
    if (tx) payments = await horizon.getPayments(sellerTxHash);
  } catch (err) {
    // Horizon down or erroring: say so instead of guessing either way. Only the
    // error class/message is kept, never a response body.
    const why = err instanceof Error ? err.message.slice(0, 120) : "unknown error";
    return done("unverified", `could not check the claimed hash on Horizon (${why})`);
  }

  if (!tx) {
    item.mismatchFields.push("hash");
    return done("transfer_mismatch", "claimed hash was not found on Horizon");
  }

  const mismatches = item.mismatchFields;
  if (!tx.successful) mismatches.push("tx_failed");
  if (duplicateClaim) mismatches.push("duplicate_claim");

  const dest = exp.transfer?.destination ?? null;
  // Candidate payments: those to the anchor's destination when known, else any.
  const toDest = dest ? payments.filter((p) => p.to === dest) : payments;
  const wantAmount = parseDecimal(exp.amount);
  const checkPayment = (p: HorizonPayment): MismatchField[] => {
    const bad: MismatchField[] = [];
    if (job.account && p.from !== job.account) bad.push("source");
    if (exp.asset && !sameAsset(p.asset, exp.asset)) bad.push("asset");
    const got = parseDecimal(p.amount);
    if (wantAmount === null || got === null || got !== wantAmount) bad.push("amount");
    return bad;
  };
  if (toDest.length === 0) {
    // No payment to the anchor (or no payment operation at all).
    mismatches.push("destination");
  } else {
    // The payment failing the fewest checks is the one reported.
    mismatches.push(...toDest.map(checkPayment).sort((a, b) => a.length - b.length)[0]!);
  }
  if (!exp.asset) item.unchecked.push("asset");

  // Memo: compared on the transaction, value never echoed.
  const wantMemo = exp.transfer?.memo ?? null;
  if (exp.transfer) {
    if (wantMemo !== null) {
      const typeOk = exp.transfer.memoType === null || tx.memoType === exp.transfer.memoType;
      if (!typeOk || tx.memo !== wantMemo) mismatches.push("memo");
    }
  } else {
    item.unchecked.push("destination", "memo");
  }

  // The anchor's own record of which transaction it received.
  if (anchorTxId && anchorTxId !== sellerTxHash) mismatches.push("anchor_tx_id");

  item.mismatchFields = [...new Set(mismatches)];
  if (item.mismatchFields.length > 0) {
    return done("transfer_mismatch", `claimed transfer differs on: ${item.mismatchFields.join(", ")}`);
  }

  // Without stored deposit instructions the destination and memo cannot be
  // checked directly. The anchor citing this very hash is the only evidence
  // they were right; absent that the result is unverified, not matched.
  if (!exp.transfer && anchorTxId !== sellerTxHash) {
    return done(
      "unverified",
      "no stored deposit instructions, so destination and memo could not be checked, and the anchor does not cite this hash",
    );
  }

  // 3. The anchor's payout.
  const completedHere = anchorCompleted || job.status === "settled";
  if (job.status === "failed") {
    return done("failed_after_transfer", "the seller's transfer is on-chain but the anchor withdrawal failed or was refunded");
  }
  if (anchorCompleted && job.status !== "settled") {
    return done("status_drift", `anchor reports completed but the local job is "${job.status}"`);
  }
  if (!completedHere) {
    return done("pending", "transfer verified on-chain; waiting for the anchor payout");
  }

  const quoted = parseDecimal(quotedNetAmount);
  const out = parseDecimal(amountOut);
  if (quoted === null || out === null || quoted === 0n) {
    item.unchecked.push("payout");
    return done("unverified", "transfer verified; payout could not be compared (quoted net amount or amount_out missing or unparseable)");
  }
  const shortfall = quoted - out;
  item.shortfall = formatDecimal(shortfall);
  item.shortfallPct = pctOf(shortfall, quoted);
  const tol = parseDecimal(tolerancePct);
  if (tol === null) throw new Error(`invalid tolerance "${tolerancePct}"`);
  // shortfall/quoted > tol/100  <=>  shortfall * 100 > tol * quoted  (all at SCALE)
  if (shortfall * 100n * SCALE_FACTOR > tol * quoted) {
    return done(
      "payout_short",
      `anchor paid ${item.amountOut} ${job.targetCurrency} against a quoted net of ${quotedNetAmount} (short by ${item.shortfall}, ${item.shortfallPct}%)`,
    );
  }
  return done("matched", null);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function emptyCounts(): Record<ReconciliationStatus, number> {
  return {
    matched: 0,
    no_transfer: 0,
    transfer_mismatch: 0,
    payout_short: 0,
    pending: 0,
    failed_after_transfer: 0,
    status_drift: 0,
    unverified: 0,
  };
}

export class ReconciliationService {
  constructor(private readonly deps: ReconciliationDeps) {}

  async generateReport(opts: { from: number; to: number; tolerancePct?: string }): Promise<ReconciliationReport> {
    const tolerancePct = opts.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
    if (parseDecimal(tolerancePct) === null) throw new Error(`invalid tolerance "${tolerancePct}"`);

    const jobs = await this.deps.jobs.listJobsCreatedBetween(opts.from, opts.to);

    const claimCount = new Map<string, number>();
    for (const j of jobs) {
      if (!j.sellerTxHash) continue;
      const h = j.sellerTxHash.toLowerCase();
      claimCount.set(h, (claimCount.get(h) ?? 0) + 1);
    }

    const items: ReconciliationItem[] = [];
    const counts = emptyCounts();
    for (const job of jobs) {
      const link = await this.deps.links.findById(job.linkId);
      const dup = job.sellerTxHash ? (claimCount.get(job.sellerTxHash.toLowerCase()) ?? 0) > 1 : false;
      const item = await reconcileJob(job, link, this.deps.horizon, tolerancePct, dup);
      if (!link) {
        item.unchecked.push("link");
        if (item.status === "matched") {
          item.status = "unverified";
          item.detail = "the link row for this job is missing, so the quoted amount is unknown";
        }
      }
      counts[item.status]++;
      items.push(item);
    }

    return {
      from: opts.from,
      to: opts.to,
      tolerancePct,
      generatedAt: Date.now(),
      total: items.length,
      counts,
      items,
    };
  }
}

// ---------------------------------------------------------------------------
// Horizon client
// ---------------------------------------------------------------------------

/** Horizon over plain fetch. Reads only; the base URL comes from resolveStellarConfig. */
export function createHorizonLookup(
  horizonUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): HorizonLookup {
  const base = horizonUrl.replace(/\/+$/, "");
  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error(`Horizon answered HTTP ${res.status}`);
    return { status: res.status, body: await res.json() };
  }
  return {
    async getTransaction(hash) {
      if (!HASH_RE.test(hash)) throw new Error("refusing to query a malformed hash");
      const { status, body } = await getJson(`/transactions/${hash}`);
      if (status === 404) return null;
      const t = body as { successful?: boolean; memo_type?: string; memo?: string };
      return {
        successful: t.successful === true,
        memoType: t.memo_type && t.memo_type !== "none" ? t.memo_type : null,
        memo: typeof t.memo === "string" ? t.memo : null,
      };
    },
    async getPayments(hash) {
      if (!HASH_RE.test(hash)) throw new Error("refusing to query a malformed hash");
      const { status, body } = await getJson(`/transactions/${hash}/operations?limit=200`);
      if (status === 404) return [];
      const records =
        ((body as { _embedded?: { records?: Array<Record<string, string>> } })._embedded?.records) ?? [];
      const out: HorizonPayment[] = [];
      for (const r of records) {
        if (r.type !== "payment") continue;
        if (!r.to || !r.amount) continue;
        out.push({
          from: r.from ?? r.source_account ?? "",
          to: r.to,
          amount: r.amount,
          asset:
            r.asset_type === "native"
              ? { code: "XLM", issuer: null }
              : { code: r.asset_code ?? "", issuer: r.asset_issuer ?? null },
        });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

/** A bare YYYY-MM-DD is a UTC day; `endOfDay` makes `--to` cover that whole day. */
export function parseBoundary(value: string, endOfDay: boolean): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(ms)) throw new Error(`not a date: "${value}" (use YYYY-MM-DD or an ISO timestamp)`);
  return dateOnly && endOfDay ? ms + 24 * 3600 * 1000 - 1 : ms;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function formatReportAsText(report: ReconciliationReport): string {
  const lines: string[] = [];
  lines.push(
    `Reconciliation ${new Date(report.from).toISOString()} .. ${new Date(report.to).toISOString()}  (payout tolerance ${report.tolerancePct}%)`,
  );
  lines.push(`Withdrawals: ${report.total}`);
  for (const [status, n] of Object.entries(report.counts)) {
    if (n > 0 || status === "matched") lines.push(`  ${status.padEnd(22)} ${n}`);
  }
  const flagged = report.items.filter((i) => i.status !== "matched" && i.status !== "pending");
  if (flagged.length > 0) {
    lines.push("", "Needs attention:");
    for (const i of flagged) {
      lines.push(`  [${i.status}] job ${i.jobId} link ${i.linkId} account ${i.account ?? "-"}`);
      if (i.detail) lines.push(`      ${i.detail}`);
    }
  }
  return lines.join("\n");
}

const CSV_HEADERS = [
  "job_id",
  "link_id",
  "seller_id",
  "account",
  "anchor",
  "status",
  "mismatch_fields",
  "unchecked",
  "job_status",
  "anchor_status",
  "seller_tx_hash",
  "anchor_tx_id",
  "sell_asset",
  "expected_transfer_amount",
  "anchor_amount_in",
  "target_currency",
  "quoted_net_amount",
  "amount_out",
  "shortfall",
  "shortfall_pct",
  "detail",
  "created_at",
] as const;

/** Quote every cell; neutralise spreadsheet formula triggers. */
function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function formatReportAsCsv(report: ReconciliationReport): string {
  const rows = report.items.map((i) =>
    [
      i.jobId,
      i.linkId,
      i.sellerId,
      i.account,
      i.anchor,
      i.status,
      i.mismatchFields.join(" "),
      i.unchecked.join(" "),
      i.jobStatus,
      i.anchorStatus,
      i.sellerTxHash,
      i.anchorTxId,
      i.sellAsset,
      i.expectedTransferAmount,
      i.anchorAmountIn,
      i.targetCurrency,
      i.quotedNetAmount,
      i.amountOut,
      i.shortfall,
      i.shortfallPct,
      i.detail,
      new Date(i.createdAt).toISOString(),
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_HEADERS.map(csvCell).join(","), ...rows].join("\n") + "\n";
}
