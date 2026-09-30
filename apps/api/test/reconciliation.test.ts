import { describe, it, expect, beforeEach } from "vitest";
import { createTestContainer, type TestContainer } from "./setup";
import {
  ReconciliationService,
  reconcileJobAndLink,
  formatReportAsText,
  formatReportAsCsv,
} from "../src/services/reconciliation";
import { linkRoutes } from "../src/routes/links";
import type { StoredOffRampJob, PaymentLink } from "@checkout/core";

describe("Reconciliation Report & Service", () => {
  let c: TestContainer;
  let service: ReconciliationService;

  beforeEach(async () => {
    c = await createTestContainer();
    service = new ReconciliationService(c.links, c.offrampState);
  });

  describe("reconcileJobAndLink logic", () => {
    const baseLink: PaymentLink = {
      id: "lnk_test_123",
      reference: "ref_123",
      sellerId: "sel_1",
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      muxedId: null,
      title: "Invoice #1",
      amount: "100.00",
      asset: { code: "USDC", issuer: null },
      status: "paid",
      txHash: "tx_payment_hash",
      payer: "G_PAYER",
      paidAmount: "100.00",
      overpaidAmount: null,
      offrampJobId: "job_123",
      offrampTargetCurrency: "NGN",
      offrampStatus: "settled",
      offrampIndicativeRate: "1500",
      offrampRate: "1500",
      offrampRateDelta: "0",
      offrampFeeAmount: "1.00",
      offrampFeeCurrency: "USDC",
      offrampFeeSource: "anchor",
      offrampNetTargetAmount: "148500",
      expiresAt: null,
      isDemo: false,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
    };

    const baseJob: StoredOffRampJob = {
      jobId: "job_123",
      linkId: "lnk_test_123",
      anchor: "testanchor",
      targetCurrency: "NGN",
      targetAmount: "150000",
      rate: "1500",
      status: "settled",
      externalStatus: "completed",
      lastError: null,
      transferNotifiedAt: null,
      sellerId: null,
      account: null,
      sellerTxHash: "tx_seller_transfer_123",
      stellarTransactionId: "tx_seller_transfer_123",
      amountIn: "100.00",
      amountFee: "1.00",
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
    };

    it("identifies matched withdrawals", () => {
      const item = reconcileJobAndLink(baseJob, baseLink);
      expect(item.status).toBe("matched");
      expect(item.discrepancyReason).toBeNull();
    });

    it("identifies transfer_mismatch when sellerTxHash != stellarTransactionId", () => {
      const mismatchedJob: StoredOffRampJob = {
        ...baseJob,
        sellerTxHash: "tx_seller_hash_A",
        stellarTransactionId: "tx_anchor_hash_B",
      };
      const item = reconcileJobAndLink(mismatchedJob, baseLink);
      expect(item.status).toBe("transfer_mismatch");
      expect(item.discrepancyReason).toContain("does not match");
    });

    it("identifies transfer_mismatch when anchor amountIn differs from link amount", () => {
      const mismatchedAmountJob: StoredOffRampJob = {
        ...baseJob,
        amountIn: "50.00",
      };
      const item = reconcileJobAndLink(mismatchedAmountJob, baseLink);
      expect(item.status).toBe("transfer_mismatch");
      expect(item.discrepancyReason).toContain("does not match link payment");
    });

    it("identifies payout_short when settled amount is significantly less than expected", () => {
      const shortPayoutJob: StoredOffRampJob = {
        ...baseJob,
        targetAmount: "120000", // quoted was 150000
      };
      const item = reconcileJobAndLink(shortPayoutJob, baseLink);
      expect(item.status).toBe("payout_short");
      expect(item.discrepancyReason).toContain("less than expected");
    });

    it("identifies no_transfer when settled without any recorded transfer", () => {
      const noTransferJob: StoredOffRampJob = {
        ...baseJob,
        sellerTxHash: null,
        stellarTransactionId: null,
        amountIn: null,
      };
      const item = reconcileJobAndLink(noTransferJob, baseLink);
      expect(item.status).toBe("no_transfer");
      expect(item.discrepancyReason).toContain("no recorded seller transfer");
    });

    it("identifies pending jobs", () => {
      const pendingJob: StoredOffRampJob = {
        ...baseJob,
        status: "pending",
        externalStatus: "pending_anchor",
      };
      const item = reconcileJobAndLink(pendingJob, baseLink);
      expect(item.status).toBe("pending");
    });
  });

  describe("ReconciliationService.generateReport", () => {
    it("aggregates and filters reconciliation report items", async () => {
      // Create seller 1 link & job
      const created1 = await c.service.createLink(c.seller.id, {
        title: "Link 1",
        amount: "50.00",
        assetCode: "USDC",
      });
      await c.offrampState.saveJob({
        jobId: "job_match",
        linkId: created1.link.id,
        anchor: "testanchor",
        targetCurrency: "NGN",
        targetAmount: "75000",
        rate: "1500",
        status: "settled",
        externalStatus: "completed",
        lastError: null,
        transferNotifiedAt: null,
        sellerId: null,
        account: null,
        sellerTxHash: "tx_hash_1",
        stellarTransactionId: "tx_hash_1",
        amountIn: "50.00",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Create seller 1 link 2 & job
      const created2 = await c.service.createLink(c.seller.id, {
        title: "Link 2",
        amount: "100.00",
        assetCode: "USDC",
      });
      await c.offrampState.saveJob({
        jobId: "job_mismatch",
        linkId: created2.link.id,
        anchor: "testanchor",
        targetCurrency: "NGN",
        targetAmount: "150000",
        rate: "1500",
        status: "settled",
        externalStatus: "completed",
        lastError: null,
        transferNotifiedAt: null,
        sellerId: null,
        account: null,
        sellerTxHash: "tx_seller_reported",
        stellarTransactionId: "tx_different_anchor_id",
        amountIn: "100.00",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const report = await service.generateReport();
      expect(report.totalWithdrawals).toBe(2);
      expect(report.matchedCount).toBe(1);
      expect(report.transferMismatchCount).toBe(1);

      // Filtering by status
      const filtered = await service.generateReport({ status: "transfer_mismatch" });
      expect(filtered.totalWithdrawals).toBe(1);
      expect(filtered.items[0]?.jobId).toBe("job_mismatch");

      // Formatting
      const text = formatReportAsText(report);
      expect(text).toContain("QUAY RECONCILIATION REPORT");
      expect(text).toContain("Total Withdrawals:    2");
      expect(text).toContain("Matched:           1");

      const csv = formatReportAsCsv(report);
      expect(csv).toContain("link_id,job_id,seller_id");
      expect(csv).toContain("job_match");
      expect(csv).toContain("job_mismatch");
    });
  });

  describe("POST /links/:id/cash-out/transfer-sent route", () => {
    it("updates sellerTxHash on offramp_jobs record", async () => {
      const app = linkRoutes(c as any, async (_ctx, next) => next());
      const token = await c.tokenFor(c.seller.id, c.seller.wallet);

      const created = await c.service.createLink(c.seller.id, {
        title: "Cashout Link",
        amount: "25.00",
        assetCode: "USDC",
      });

      // Associate an offramp job
      await c.offrampState.saveJob({
        jobId: "job_pending_1",
        linkId: created.link.id,
        anchor: "testanchor",
        targetCurrency: "NGN",
        targetAmount: "37500",
        rate: "1500",
        status: "pending",
        externalStatus: "pending_user_transfer_start",
        lastError: null,
        transferNotifiedAt: null,
        sellerId: null,
        account: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Update link with offrampJobId
      created.link.offrampJobId = "job_pending_1";
      await c.links.save(created.link);

      const res = await app.request(`/${created.link.id}/cash-out/transfer-sent`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ txHash: "tx_seller_sent_hash_999" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; txHash: string; jobId: string };
      expect(body.ok).toBe(true);
      expect(body.txHash).toBe("tx_seller_sent_hash_999");

      // Verify DB was updated
      const updatedJob = await c.offrampState.getJob("job_pending_1");
      expect(updatedJob?.sellerTxHash).toBe("tx_seller_sent_hash_999");
    });
  });
});
