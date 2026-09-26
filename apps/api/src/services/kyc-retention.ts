import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Logger } from "@checkout/core";
import type { DB } from "../db/client";
import { anchorSessions, links, sellerKyc, sellers } from "../db/schema";
import { metrics } from "../metrics";

export interface KycRetentionOptions {
  db: DB;
  retentionDays: number;
  now?: number;
  dryRun?: boolean;
  logger?: Logger;
}

export interface KycRetentionResult {
  eligibleCount: number;
  purgedCount: number;
  skippedPendingCashOutCount: number;
  dryRun: boolean;
  anchorStatus: "anchor_not_contacted";
}

/**
 * Erases a seller's identity, KYC records, anchor sessions, and stored payout fields locally.
 * Reusable across retention sweeps and self-service privacy erasure requests.
 */
export async function eraseSellerIdentityLocal(db: DB, sellerId: string): Promise<void> {
  await db.delete(sellerKyc).where(eq(sellerKyc.sellerId, sellerId));
  await db.delete(anchorSessions).where(eq(anchorSessions.sellerId, sellerId));
  await db.update(sellers).set({ payoutFieldsJson: null }).where(eq(sellers.id, sellerId));
}

/**
 * Runs the KYC retention policy sweep.
 *
 * Inactive sellers whose last activity (or creation) exceeds `retentionDays` have their
 * KYC data, anchor sessions, and payout fields purged from local storage.
 * Sellers with in-flight cash-outs (`offramp_pending`) are preserved.
 *
 * When dryRun is true, reports eligible counts without modifying the database.
 */
export async function runKycRetentionSweep(opts: KycRetentionOptions): Promise<KycRetentionResult> {
  const { db, retentionDays, dryRun = false, logger } = opts;

  if (retentionDays <= 0) {
    return {
      eligibleCount: 0,
      purgedCount: 0,
      skippedPendingCashOutCount: 0,
      dryRun,
      anchorStatus: "anchor_not_contacted",
    };
  }

  const now = opts.now ?? Date.now();
  const cutoff = now - retentionDays * 86_400_000;

  // Find candidate sellers inactive since cutoff (or created before cutoff if lastActiveAt is null)
  const candidateSellers = await db
    .select({
      id: sellers.id,
      lastActiveAt: sellers.lastActiveAt,
      createdAt: sellers.createdAt,
    })
    .from(sellers)
    .where(
      or(
        lt(sellers.lastActiveAt, cutoff),
        and(isNull(sellers.lastActiveAt), lt(sellers.createdAt, cutoff)),
      ),
    );

  let eligibleCount = 0;
  let purgedCount = 0;
  let skippedPendingCashOutCount = 0;

  for (const seller of candidateSellers) {
    // Check if seller has any active off-ramp in progress
    const activeOfframps = await db
      .select({ id: links.id })
      .from(links)
      .where(and(eq(links.sellerId, seller.id), eq(links.status, "offramp_pending")))
      .limit(1);

    if (activeOfframps.length > 0) {
      skippedPendingCashOutCount++;
      continue;
    }

    eligibleCount++;

    if (!dryRun) {
      await eraseSellerIdentityLocal(db, seller.id);
      purgedCount++;
      metrics.kycRetentionPurgedTotal.inc();
    }
  }

  // Structured logging with ZERO seller PII
  if (logger) {
    logger.info(
      {
        event: "privacy.retention.purged",
        count: dryRun ? 0 : purgedCount,
        eligible: eligibleCount,
        skippedPendingCashOut: skippedPendingCashOutCount,
        dryRun,
      },
      "KYC retention sweep completed",
    );
  }

  return {
    eligibleCount,
    purgedCount,
    skippedPendingCashOutCount,
    dryRun,
    anchorStatus: "anchor_not_contacted",
  };
}
