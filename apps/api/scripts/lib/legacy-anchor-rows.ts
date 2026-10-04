import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { DB } from "../../src/db/client";
import { links, offrampJobs, sellerKyc } from "../../src/db/schema";

/**
 * Report and cleanup for rows written while every seller authenticated to the
 * anchor as one shared platform account (issue 4.18). Those rows carry NULL in
 * the columns the per-seller identity fix added: `offramp_jobs.seller_id` /
 * `account` and `seller_kyc.account`.
 *
 * Nothing here ever selects `seller_kyc.fields_encrypted`, so the report cannot
 * leak PII no matter what is done with its output.
 */

/** Marker written to `offramp_jobs.last_error` by the cleanup. */
export const LEGACY_JOB_MARKER = "legacy_shared_account";

/**
 * SEP-6 statuses that mean the anchor has the seller's on-chain transfer (or
 * has moved past waiting for it). A legacy job in one of these had funds sent
 * from the shared platform account.
 */
const POST_TRANSFER_EXTERNAL_STATUSES = new Set([
  "pending_anchor",
  "pending_stellar",
  "pending_external",
  "pending_receiver",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
]);

export interface LegacyJobRow {
  jobId: string;
  linkId: string;
  /** The link's current status, or null when the link row is gone. */
  linkStatus: string | null;
  /** The link's seller, or null when the link row is gone. */
  linkSellerId: string | null;
  jobStatus: string;
  externalStatus: string | null;
  /** Which of the legacy columns are NULL on this job. */
  missing: Array<"seller_id" | "account">;
  createdAt: number;
  updatedAt: number;
  /**
   * The link the poller auto-fails: still `offramp_pending`, so
   * `TestAnchorOffRamp.status()` throws and it is marked `job_state_lost`.
   */
  autoFailedAsJobStateLost: boolean;
  /**
   * The platform account probably sent USDC to the anchor for this job:
   * transfer instructions were surfaced or the anchor reports a post-transfer
   * status. A heuristic from local data; the anchor is the source of truth.
   */
  fundsMayHaveBeenSent: boolean;
  /** A `settled` legacy job: money moved, the records may need reconciling. */
  needsReconciliation: boolean;
  /** Whether `--apply` has already marked this job. */
  marked: boolean;
  /** Whether `--apply` would mark it: `last_error` is free (NULL). */
  markable: boolean;
}

export interface LegacyKycRow {
  sellerId: string;
  status: string;
  /** Whether a `customer_id` is still stored (never its value). */
  hasCustomerId: boolean;
  lastSyncedAt: number | null;
  /** Whether `--apply` would change this row (customer id or status left over). */
  needsReset: boolean;
}

export interface LegacyReport {
  jobs: LegacyJobRow[];
  kyc: LegacyKycRow[];
  totals: {
    legacyJobs: number;
    autoFailedAsJobStateLost: number;
    fundsMayHaveBeenSent: number;
    needsReconciliation: number;
    legacyKycRows: number;
    kycWithCustomerId: number;
  };
}

/** Reads the legacy rows. Read-only. */
export async function buildReport(db: DB): Promise<LegacyReport> {
  const jobRows = await db
    .select({
      jobId: offrampJobs.jobId,
      linkId: offrampJobs.linkId,
      sellerId: offrampJobs.sellerId,
      account: offrampJobs.account,
      status: offrampJobs.status,
      externalStatus: offrampJobs.externalStatus,
      lastError: offrampJobs.lastError,
      transferNotifiedAt: offrampJobs.transferNotifiedAt,
      createdAt: offrampJobs.createdAt,
      updatedAt: offrampJobs.updatedAt,
      linkStatus: links.status,
      linkSellerId: links.sellerId,
    })
    .from(offrampJobs)
    .leftJoin(links, eq(links.id, offrampJobs.linkId))
    .where(or(isNull(offrampJobs.sellerId), isNull(offrampJobs.account)))
    .orderBy(asc(offrampJobs.createdAt), asc(offrampJobs.jobId));

  const jobs: LegacyJobRow[] = jobRows.map((r) => {
    const missing: LegacyJobRow["missing"] = [];
    if (r.sellerId === null) missing.push("seller_id");
    if (r.account === null) missing.push("account");
    return {
      jobId: r.jobId,
      linkId: r.linkId,
      linkStatus: r.linkStatus ?? null,
      linkSellerId: r.linkSellerId ?? null,
      jobStatus: r.status,
      externalStatus: r.externalStatus,
      missing,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      autoFailedAsJobStateLost: r.linkStatus === "offramp_pending",
      fundsMayHaveBeenSent:
        r.transferNotifiedAt !== null ||
        (r.externalStatus !== null && POST_TRANSFER_EXTERNAL_STATUSES.has(r.externalStatus)),
      needsReconciliation: r.status === "settled",
      marked: r.lastError === LEGACY_JOB_MARKER,
      markable: r.lastError === null,
    };
  });

  const kycRows = await db
    .select({
      sellerId: sellerKyc.sellerId,
      status: sellerKyc.status,
      customerId: sellerKyc.customerId,
      lastSyncedAt: sellerKyc.lastSyncedAt,
    })
    .from(sellerKyc)
    .where(isNull(sellerKyc.account))
    .orderBy(asc(sellerKyc.sellerId));

  const kyc: LegacyKycRow[] = kycRows.map((r) => ({
    sellerId: r.sellerId,
    status: r.status,
    hasCustomerId: r.customerId !== null,
    lastSyncedAt: r.lastSyncedAt,
    needsReset: r.customerId !== null || r.status !== "unsubmitted",
  }));

  return {
    jobs,
    kyc,
    totals: {
      legacyJobs: jobs.length,
      autoFailedAsJobStateLost: jobs.filter((j) => j.autoFailedAsJobStateLost).length,
      fundsMayHaveBeenSent: jobs.filter((j) => j.fundsMayHaveBeenSent).length,
      needsReconciliation: jobs.filter((j) => j.needsReconciliation).length,
      legacyKycRows: kyc.length,
      kycWithCustomerId: kyc.filter((k) => k.hasCustomerId).length,
    },
  };
}

export interface ApplyResult {
  kycReset: number;
  jobsMarked: number;
}

/**
 * The cleanup. Touches only legacy rows and is idempotent: a second run finds
 * nothing left to change.
 *
 * - `seller_kyc` (account IS NULL): clears `customer_id` and returns the status
 *   to `unsubmitted`, so the next sync starts from the seller's own account.
 *   The encrypted reusable profile (`fields_encrypted`) is kept.
 * - `offramp_jobs` (seller_id or account IS NULL): sets `last_error` to
 *   {@link LEGACY_JOB_MARKER} where it is free. Nothing else changes, and
 *   `updated_at` is left alone; the rows are the audit trail.
 */
export async function applyCleanup(db: DB, now: number = Date.now()): Promise<ApplyResult> {
  const kyc = await db
    .update(sellerKyc)
    .set({ customerId: null, status: "unsubmitted", updatedAt: now })
    .where(
      and(
        isNull(sellerKyc.account),
        or(sql`${sellerKyc.customerId} IS NOT NULL`, ne(sellerKyc.status, "unsubmitted")),
      ),
    );

  const jobs = await db
    .update(offrampJobs)
    .set({ lastError: LEGACY_JOB_MARKER })
    .where(
      and(
        or(isNull(offrampJobs.sellerId), isNull(offrampJobs.account)),
        isNull(offrampJobs.lastError),
      ),
    );

  return { kycReset: kyc.rowsAffected, jobsMarked: jobs.rowsAffected };
}

/** Human-readable rendering of a report. Contains no PII by construction. */
export function formatReport(report: LegacyReport): string {
  const lines: string[] = [];
  const when = (ms: number | null) => (ms === null ? "never" : new Date(ms).toISOString());

  lines.push("offramp_jobs with seller_id or account NULL");
  if (report.jobs.length === 0) lines.push("  (none)");
  for (const j of report.jobs) {
    lines.push(
      `  job ${j.jobId}  link ${j.linkId} (${j.linkStatus ?? "link missing"}, seller ${j.linkSellerId ?? "?"})`,
    );
    lines.push(
      `    job status ${j.jobStatus}, external status ${j.externalStatus ?? "none"}, missing ${j.missing.join("+")}`,
    );
    lines.push(`    created ${when(j.createdAt)}, updated ${when(j.updatedAt)}`);
    const flags = [
      j.autoFailedAsJobStateLost && "auto-failed as job_state_lost",
      j.fundsMayHaveBeenSent && "FUNDS MAY HAVE BEEN SENT",
      j.needsReconciliation && "settled: needs reconciliation",
      j.marked && "marked",
    ].filter(Boolean);
    if (flags.length) lines.push(`    ${flags.join("; ")}`);
  }

  lines.push("", "seller_kyc with account NULL");
  if (report.kyc.length === 0) lines.push("  (none)");
  for (const k of report.kyc) {
    lines.push(
      `  seller ${k.sellerId}  status ${k.status}, customer_id ${k.hasCustomerId ? "set" : "not set"}, last synced ${when(k.lastSyncedAt)}${k.needsReset ? "" : " (already reset)"}`,
    );
  }

  const t = report.totals;
  lines.push(
    "",
    "totals",
    `  legacy jobs:                      ${t.legacyJobs}`,
    `  auto-failed as job_state_lost:    ${t.autoFailedAsJobStateLost}`,
    `  funds may have been sent:         ${t.fundsMayHaveBeenSent}`,
    `  settled, needing reconciliation:  ${t.needsReconciliation}`,
    `  legacy seller_kyc rows:           ${t.legacyKycRows}`,
    `  ... still holding a customer_id:  ${t.kycWithCustomerId}`,
  );
  return lines.join("\n");
}
