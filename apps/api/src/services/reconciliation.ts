import type { StoredOffRampJob, PaymentLink } from "@checkout/core";
import { DrizzleLinkRepository, DrizzleOffRampStateRepository } from "../repos/index";
import type { DB } from "../db/client";

export type ReconciliationStatus =
  | "matched"
  | "no_transfer"
  | "transfer_mismatch"
  | "payout_short"
  | "pending";

export interface ReconciliationItem {
  linkId: string;
  jobId: string;
  sellerId: string;
  linkTitle: string;
  linkAmount: string;
  linkAsset: string;
  linkStatus: string;
  targetCurrency: string;
  quotedRate: string;
  quotedTargetAmount: string;
  settledTargetAmount: string | null;
  sellerTxHash: string | null;
  stellarTransactionId: string | null;
  amountIn: string | null;
  amountFee: string | null;
  anchorStatus: string | null;
  jobStatus: string;
  status: ReconciliationStatus;
  discrepancyReason: string | null;
  createdAt: number;
}

export interface ReconciliationReport {
  generatedAt: number;
  totalWithdrawals: number;
  matchedCount: number;
  pendingCount: number;
  noTransferCount: number;
  transferMismatchCount: number;
  payoutShortCount: number;
  items: ReconciliationItem[];
}

export interface ReconciliationFilters {
  sellerId?: string;
  status?: ReconciliationStatus;
  since?: number;
}

export function reconcileJobAndLink(job: StoredOffRampJob, link: PaymentLink | null): ReconciliationItem {
  const linkTitle = link?.title ?? "Unknown";
  const linkAmount = link?.paidAmount ?? link?.amount ?? "0";
  const linkAsset = link?.asset.code ?? "USDC";
  const linkStatus = link?.status ?? "unknown";
  const sellerId = link?.sellerId ?? "unknown";

  const sellerTxHash = job.sellerTxHash ?? null;
  const stellarTransactionId = job.stellarTransactionId ?? null;
  const amountIn = job.amountIn ?? null;
  const amountFee = job.amountFee ?? null;
  const settledTargetAmount = job.targetAmount || null;
  const anchorStatus = job.externalStatus ?? null;
  const jobStatus = job.status;

  let status: ReconciliationStatus = "pending";
  let discrepancyReason: string | null = null;

  if (jobStatus === "settled" || anchorStatus === "completed") {
    const expectedTargetAmount = link?.offrampNetTargetAmount || link?.offrampRate || null;
    if (sellerTxHash && stellarTransactionId && sellerTxHash.toLowerCase() !== stellarTransactionId.toLowerCase()) {
      status = "transfer_mismatch";
      discrepancyReason = `Seller tx hash (${sellerTxHash}) does not match anchor stellar tx id (${stellarTransactionId})`;
    } else if (amountIn && Number(amountIn) > 0 && Number(linkAmount) > 0 && Math.abs(Number(amountIn) - Number(linkAmount)) > 0.01) {
      status = "transfer_mismatch";
      discrepancyReason = `Anchor amount_in (${amountIn}) does not match link payment (${linkAmount})`;
    } else if (
      settledTargetAmount &&
      expectedTargetAmount &&
      Number(settledTargetAmount) > 0 &&
      Number(expectedTargetAmount) > 0 &&
      Number(settledTargetAmount) < Number(expectedTargetAmount) * 0.99
    ) {
      status = "payout_short";
      discrepancyReason = `Settled target amount (${settledTargetAmount}) is less than expected (${expectedTargetAmount})`;
    } else if (!sellerTxHash && !stellarTransactionId && !amountIn) {
      status = "no_transfer";
      discrepancyReason = "Settled job has no recorded seller transfer or anchor stellar transaction id";
    } else {
      status = "matched";
    }
  } else if (jobStatus === "failed" || anchorStatus === "error" || anchorStatus === "refunded") {
    if (sellerTxHash || stellarTransactionId) {
      status = "transfer_mismatch";
      discrepancyReason = job.lastError ?? `Anchor offramp failed (${anchorStatus ?? jobStatus}) after transfer was sent`;
    } else {
      status = "no_transfer";
      discrepancyReason = job.lastError ?? `Anchor offramp failed (${anchorStatus ?? jobStatus}) with no transfer`;
    }
  } else {
    // Pending
    if (!sellerTxHash && !stellarTransactionId) {
      if (anchorStatus === "pending_user_transfer_start") {
        status = "no_transfer";
        discrepancyReason = "Anchor is waiting for seller on-chain transfer";
      } else {
        status = "pending";
      }
    } else {
      status = "pending";
    }
  }

  return {
    linkId: job.linkId,
    jobId: job.jobId,
    sellerId,
    linkTitle,
    linkAmount,
    linkAsset,
    linkStatus,
    targetCurrency: job.targetCurrency,
    quotedRate: job.rate,
    quotedTargetAmount: job.targetAmount,
    settledTargetAmount,
    sellerTxHash,
    stellarTransactionId,
    amountIn,
    amountFee,
    anchorStatus,
    jobStatus,
    status,
    discrepancyReason,
    createdAt: job.createdAt,
  };
}

export class ReconciliationService {
  constructor(
    private readonly linksRepo: DrizzleLinkRepository,
    private readonly offrampRepo: DrizzleOffRampStateRepository,
  ) {}

  async generateReport(filters: ReconciliationFilters = {}): Promise<ReconciliationReport> {
    const jobs = await this.offrampRepo.listJobs();
    const items: ReconciliationItem[] = [];

    for (const job of jobs) {
      if (filters.since && job.createdAt < filters.since) continue;
      const link = await this.linksRepo.findById(job.linkId);
      if (filters.sellerId && link && link.sellerId !== filters.sellerId) continue;

      const item = reconcileJobAndLink(job, link);
      if (filters.status && item.status !== filters.status) continue;
      items.push(item);
    }

    const matchedCount = items.filter((i) => i.status === "matched").length;
    const pendingCount = items.filter((i) => i.status === "pending").length;
    const noTransferCount = items.filter((i) => i.status === "no_transfer").length;
    const transferMismatchCount = items.filter((i) => i.status === "transfer_mismatch").length;
    const payoutShortCount = items.filter((i) => i.status === "payout_short").length;

    return {
      generatedAt: Date.now(),
      totalWithdrawals: items.length,
      matchedCount,
      pendingCount,
      noTransferCount,
      transferMismatchCount,
      payoutShortCount,
      items,
    };
  }
}

export function formatReportAsText(report: ReconciliationReport): string {
  const lines: string[] = [];
  lines.push("================================================================================");
  lines.push("                        QUAY RECONCILIATION REPORT                              ");
  lines.push(`Generated: ${new Date(report.generatedAt).toISOString()}`);
  lines.push("================================================================================");
  lines.push(`Total Withdrawals:    ${report.totalWithdrawals}`);
  lines.push(`  ✓ Matched:           ${report.matchedCount}`);
  lines.push(`  ⏳ Pending:           ${report.pendingCount}`);
  lines.push(`  ⚠ No Transfer:       ${report.noTransferCount}`);
  lines.push(`  ❌ Transfer Mismatch: ${report.transferMismatchCount}`);
  lines.push(`  ⚠ Payout Short:      ${report.payoutShortCount}`);
  lines.push("--------------------------------------------------------------------------------");
  lines.push("");

  if (report.items.length === 0) {
    lines.push("No off-ramp withdrawals found matching criteria.");
    return lines.join("\n");
  }

  lines.push(
    [
      "Status".padEnd(18),
      "Link ID".padEnd(14),
      "Job ID".padEnd(14),
      "Amount In".padEnd(12),
      "Payout".padEnd(14),
      "Seller Tx".padEnd(16),
      "Anchor Tx".padEnd(16),
    ].join(" | "),
  );
  lines.push("-".repeat(95));

  for (const item of report.items) {
    const payoutStr = `${item.settledTargetAmount ?? item.quotedTargetAmount} ${item.targetCurrency}`;
    const amountInStr = `${item.amountIn ?? item.linkAmount} ${item.linkAsset}`;
    const sellerTxStr = item.sellerTxHash ? `${item.sellerTxHash.slice(0, 12)}…` : "none";
    const anchorTxStr = item.stellarTransactionId ? `${item.stellarTransactionId.slice(0, 12)}…` : "none";

    lines.push(
      [
        item.status.padEnd(18),
        item.linkId.slice(0, 12).padEnd(14),
        item.jobId.slice(0, 12).padEnd(14),
        amountInStr.padEnd(12),
        payoutStr.padEnd(14),
        sellerTxStr.padEnd(16),
        anchorTxStr.padEnd(16),
      ].join(" | "),
    );
    if (item.discrepancyReason) {
      lines.push(`  ↳ Discrepancy: ${item.discrepancyReason}`);
    }
  }

  lines.push("================================================================================");
  return lines.join("\n");
}

export function formatReportAsCsv(report: ReconciliationReport): string {
  const headers = [
    "link_id",
    "job_id",
    "seller_id",
    "status",
    "link_amount",
    "link_asset",
    "target_currency",
    "quoted_target_amount",
    "settled_target_amount",
    "seller_tx_hash",
    "stellar_transaction_id",
    "amount_in",
    "amount_fee",
    "anchor_status",
    "job_status",
    "discrepancy_reason",
    "created_at",
  ];

  const rows = report.items.map((i) =>
    [
      i.linkId,
      i.jobId,
      i.sellerId,
      i.status,
      i.linkAmount,
      i.linkAsset,
      i.targetCurrency,
      i.quotedTargetAmount,
      i.settledTargetAmount ?? "",
      i.sellerTxHash ?? "",
      i.stellarTransactionId ?? "",
      i.amountIn ?? "",
      i.amountFee ?? "",
      i.anchorStatus ?? "",
      i.jobStatus,
      `"${(i.discrepancyReason ?? "").replace(/"/g, '""')}"`,
      new Date(i.createdAt).toISOString(),
    ].join(","),
  );

  return [headers.join(","), ...rows].join("\n");
}
