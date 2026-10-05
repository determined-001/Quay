import { describe, expect, it, vi } from "vitest";
import type { StoredOffRampJob, WithdrawTransfer } from "@checkout/core";
import {
  ReconciliationService,
  createHorizonLookup,
  formatDecimal,
  formatReportAsCsv,
  formatReportAsText,
  parseBoundary,
  parseDecimal,
  reconcileJob,
  type HorizonLookup,
  type HorizonPayment,
  type HorizonTransaction,
} from "../src/services/reconciliation";
import { makeLink } from "./fakes";

const USDC = { code: "USDC", issuer: "GISSUER" };
const SELLER = "GSELLERACCOUNT";
const ANCHOR = "GANCHORDEPOSIT";
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

const TRANSFER: WithdrawTransfer = { destination: ANCHOR, amount: "10", asset: USDC, memo: "4242", memoType: "id" };

function job(over: Partial<StoredOffRampJob> = {}): StoredOffRampJob {
  return {
    jobId: "wd_1",
    linkId: "lnk_1",
    anchor: "anchor.example",
    sellerId: "sel_1",
    account: SELLER,
    targetCurrency: "NGN",
    targetAmount: "9950",
    rate: "1000",
    status: "settled",
    externalStatus: "completed",
    lastError: null,
    sellAsset: USDC,
    sellAmount: "10",
    transfer: TRANSFER,
    transferNotifiedAt: 1,
    sellerTxHash: HASH,
    amountIn: "10",
    amountFee: "50",
    stellarTransactionId: HASH,
    createdAt: Date.UTC(2026, 8, 10),
    updatedAt: 1,
    ...over,
  };
}

const link = makeLink({ offrampNetTargetAmount: "9950" });

const okTx: HorizonTransaction = { successful: true, memoType: "id", memo: "4242" };
const okPayment: HorizonPayment = { from: SELLER, to: ANCHOR, amount: "10.0000000", asset: USDC };

function horizon(
  tx: HorizonTransaction | null = okTx,
  payments: HorizonPayment[] = [okPayment],
): HorizonLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getTransaction: async (h) => {
      calls.push(h);
      return tx;
    },
    getPayments: async () => payments,
  };
}

const run = (j: StoredOffRampJob, h: HorizonLookup = horizon(), tol = "0.5", dup = false) =>
  reconcileJob(j, link, h, tol, dup);

describe("exact decimals", () => {
  it("parses and formats without floating point", () => {
    expect(parseDecimal("10")).toBe(parseDecimal("10.0000000"));
    expect(parseDecimal("0.1")! + parseDecimal("0.2")!).toBe(parseDecimal("0.3"));
    expect(formatDecimal(parseDecimal("1234.5600")!)).toBe("1234.56");
    expect(formatDecimal(parseDecimal("0")!)).toBe("0");
  });

  it("rejects anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", "abc", "-1", "1e3", "1.", ".5", "NaN", "1,5", "1.1234567890123"]) {
      expect(parseDecimal(bad)).toBeNull();
    }
    expect(parseDecimal(null)).toBeNull();
  });

  it("parses date boundaries, treating a bare --to date as the whole UTC day", () => {
    expect(parseBoundary("2026-09-01", false)).toBe(Date.UTC(2026, 8, 1));
    expect(parseBoundary("2026-09-30", true)).toBe(Date.UTC(2026, 9, 1) - 1);
    expect(() => parseBoundary("soon", false)).toThrow(/not a date/);
  });
});

describe("reconcileJob — transfer", () => {
  it("matches when transfer, anchor id and payout all agree (amounts compared as decimals)", async () => {
    const item = await run(job());
    expect(item.status).toBe("matched");
    expect(item.mismatchFields).toEqual([]);
    expect(item.shortfall).toBe("0");
  });

  it("reports a right-amount payment with the wrong memo as transfer_mismatch naming the memo, without echoing it", async () => {
    const item = await run(job(), horizon({ ...okTx, memo: "9999" }));
    expect(item.status).toBe("transfer_mismatch");
    expect(item.mismatchFields).toEqual(["memo"]);
    expect(item.detail).toContain("memo");
    expect(JSON.stringify(item)).not.toContain("9999");
    expect(JSON.stringify(item)).not.toContain("4242");
  });

  it("flags a memo type mismatch as memo", async () => {
    const item = await run(job(), horizon({ ...okTx, memoType: "text" }));
    expect(item.mismatchFields).toEqual(["memo"]);
  });

  it.each([
    ["destination", [{ ...okPayment, to: "GSOMEONEELSE" }]],
    ["source", [{ ...okPayment, from: "GOTHER" }]],
    ["asset", [{ ...okPayment, asset: { code: "USDC", issuer: "GFAKE" } }]],
    ["amount", [{ ...okPayment, amount: "9.9999999" }]],
  ] as const)("names %s when only that field differs", async (field, payments) => {
    const item = await run(job(), horizon(okTx, [...payments]));
    expect(item.status).toBe("transfer_mismatch");
    expect(item.mismatchFields).toEqual([field]);
  });

  it("does not let a tiny float-looking difference through: 10 vs 10.0000001", async () => {
    const item = await run(job(), horizon(okTx, [{ ...okPayment, amount: "10.0000001" }]));
    expect(item.mismatchFields).toEqual(["amount"]);
  });

  it("picks the best of several payments to the anchor", async () => {
    const item = await run(job(), horizon(okTx, [{ ...okPayment, amount: "1" }, okPayment]));
    expect(item.status).toBe("matched");
  });

  it("reports no payment operation at all as a destination mismatch", async () => {
    const item = await run(job(), horizon(okTx, []));
    expect(item.mismatchFields).toEqual(["destination"]);
  });

  it("reports a hash that Horizon does not know", async () => {
    const item = await run(job({ stellarTransactionId: null }), horizon(null));
    expect(item.status).toBe("transfer_mismatch");
    expect(item.mismatchFields).toEqual(["hash"]);
  });

  it("reports a failed on-chain transaction", async () => {
    const item = await run(job(), horizon({ ...okTx, successful: false }));
    expect(item.mismatchFields).toEqual(["tx_failed"]);
  });

  it("reports an anchor that cites a different transaction than the seller's", async () => {
    const item = await run(job({ stellarTransactionId: HASH2 }));
    expect(item.status).toBe("transfer_mismatch");
    expect(item.mismatchFields).toEqual(["anchor_tx_id"]);
  });

  it("reports a hash claimed by more than one job", async () => {
    const item = await run(job(), horizon(), "0.5", true);
    expect(item.mismatchFields).toEqual(["duplicate_claim"]);
  });

  it("rejects a malformed stored hash without calling Horizon", async () => {
    const h = horizon();
    const item = await run(job({ sellerTxHash: "../../etc" }), h);
    expect(item.mismatchFields).toEqual(["hash"]);
    expect(h.calls).toEqual([]);
  });

  it("reports unverified, not a crash, when Horizon fails", async () => {
    const h: HorizonLookup = {
      getTransaction: async () => {
        throw new Error("Horizon answered HTTP 503");
      },
      getPayments: async () => [],
    };
    const item = await run(job(), h);
    expect(item.status).toBe("unverified");
    expect(item.detail).toContain("HTTP 503");
  });
});

describe("reconcileJob — missing and partial data", () => {
  it("no claimed hash after the anchor completed is no_transfer", async () => {
    const item = await run(job({ sellerTxHash: null }));
    expect(item.status).toBe("no_transfer");
    expect(item.detail).toContain("never reported");
  });

  it("a withdrawal still waiting for the transfer is pending", async () => {
    const item = await run(
      job({ sellerTxHash: null, status: "awaiting_transfer", externalStatus: "pending_user_transfer_start", amountIn: null, stellarTransactionId: null }),
    );
    expect(item.status).toBe("pending");
  });

  it("a failed withdrawal with no transfer is labelled no_transfer, not matched", async () => {
    const item = await run(job({ sellerTxHash: null, status: "failed", externalStatus: "error", stellarTransactionId: null }));
    expect(item.status).toBe("no_transfer");
    expect(item.detail).toContain("failed");
  });

  it("a verified transfer with the anchor still working is pending", async () => {
    const item = await run(job({ status: "pending", externalStatus: "pending_anchor", stellarTransactionId: null }));
    expect(item.status).toBe("pending");
    expect(item.mismatchFields).toEqual([]);
  });

  it("anchor completed but local job pending is status_drift", async () => {
    const item = await run(job({ status: "pending" }));
    expect(item.status).toBe("status_drift");
    expect(item.detail).toContain('"pending"');
  });

  it("a verified transfer followed by an anchor failure is failed_after_transfer", async () => {
    const item = await run(job({ status: "failed", externalStatus: "refunded", stellarTransactionId: null }));
    expect(item.status).toBe("failed_after_transfer");
  });

  it("a job whose deposit instructions were never stored is unverified unless the anchor cites the hash", async () => {
    const citing = await run(job({ transfer: null }));
    expect(citing.status).toBe("matched");
    expect(citing.unchecked).toEqual(expect.arrayContaining(["destination", "memo"]));

    const silent = await run(job({ transfer: null, stellarTransactionId: null }));
    expect(silent.status).toBe("unverified");
  });

  it("an unparseable or missing quote or payout is unverified, never a float comparison", async () => {
    const noQuote = await reconcileJob(job(), makeLink({ offrampNetTargetAmount: null }), horizon(), "0.5");
    expect(noQuote.status).toBe("unverified");
    expect(noQuote.unchecked).toContain("payout");
    const garbage = await reconcileJob(job({ targetAmount: "1e3" }), link, horizon(), "0.5");
    expect(garbage.status).toBe("unverified");
  });
});

describe("reconcileJob — payout", () => {
  const quoted = makeLink({ offrampNetTargetAmount: "1000" });
  const payout = (out: string, tol = "0.5") => reconcileJob(job({ targetAmount: out }), quoted, horizon(), tol);

  it("is not short exactly at the tolerance (0.5% of 1000 = 5)", async () => {
    const item = await payout("995");
    expect(item.status).toBe("matched");
    expect(item.shortfall).toBe("5");
    expect(item.shortfallPct).toBe("0.5000");
  });

  it("is payout_short one unit past the tolerance, with the exact gap", async () => {
    const item = await payout("994.9999999");
    expect(item.status).toBe("payout_short");
    expect(item.shortfall).toBe("5.0000001");
    expect(item.detail).toContain("NGN");
  });

  it("honours a configured tolerance", async () => {
    expect((await payout("980", "2")).status).toBe("matched");
    expect((await payout("979", "2")).status).toBe("payout_short");
  });

  it("treats an overpayment as matched with a negative shortfall", async () => {
    const item = await payout("1001");
    expect(item.status).toBe("matched");
    expect(item.shortfall).toBe("-1");
  });

  it("reports a transfer mismatch ahead of a short payout", async () => {
    const item = await reconcileJob(job({ targetAmount: "500" }), quoted, horizon(okTx, [{ ...okPayment, amount: "9" }]), "0.5");
    expect(item.status).toBe("transfer_mismatch");
  });
});

describe("ReconciliationService", () => {
  const jobs = [
    job({ jobId: "wd_ok" }),
    job({ jobId: "wd_none", linkId: "lnk_2", sellerTxHash: null, stellarTransactionId: null }),
    job({ jobId: "wd_dup_a", linkId: "lnk_3", sellerTxHash: HASH2, stellarTransactionId: null, status: "pending", externalStatus: "pending_anchor" }),
    job({ jobId: "wd_dup_b", linkId: "lnk_4", sellerTxHash: HASH2.toUpperCase(), stellarTransactionId: null, status: "pending", externalStatus: "pending_anchor" }),
    job({ jobId: "wd_orphan", linkId: "lnk_gone", sellerTxHash: "c".repeat(64), stellarTransactionId: "c".repeat(64) }),
  ];

  function service(h = horizon()) {
    const listJobs = vi.fn(async () => jobs);
    const svc = new ReconciliationService({
      jobs: { listJobsCreatedBetween: listJobs },
      links: { findById: async (id) => (id === "lnk_gone" ? null : makeLink({ id, offrampNetTargetAmount: "9950" })) },
      horizon: h,
    });
    return { svc, listJobs };
  }

  it("covers every job in the range, counts statuses and flags duplicate claims and orphaned links", async () => {
    const { svc, listJobs } = service();
    const report = await svc.generateReport({ from: 10, to: 20 });
    expect(listJobs).toHaveBeenCalledWith(10, 20);
    expect(report.total).toBe(5);
    const by = Object.fromEntries(report.items.map((i) => [i.jobId, i]));
    expect(by.wd_ok!.status).toBe("matched");
    expect(by.wd_none!.status).toBe("no_transfer");
    expect(by.wd_dup_a!.mismatchFields).toContain("duplicate_claim");
    expect(by.wd_dup_b!.mismatchFields).toContain("duplicate_claim");
    expect(by.wd_orphan!.status).toBe("unverified");
    expect(by.wd_orphan!.unchecked).toContain("link");
    expect(report.counts).toMatchObject({ matched: 1, no_transfer: 1, transfer_mismatch: 2, unverified: 1 });
    expect(report.tolerancePct).toBe("0.5");
  });

  it("refuses an invalid tolerance", async () => {
    await expect(service().svc.generateReport({ from: 0, to: 1, tolerancePct: "half" })).rejects.toThrow(/tolerance/);
  });

  it("does not mutate the jobs it reads", async () => {
    const before = JSON.stringify(jobs);
    await service().svc.generateReport({ from: 0, to: 1 });
    expect(JSON.stringify(jobs)).toBe(before);
  });
});

describe("report output", () => {
  async function report() {
    const svc = new ReconciliationService({
      jobs: {
        listJobsCreatedBetween: async () => [
          job({ jobId: "wd_ok" }),
          job({ jobId: "wd_bad", sellerTxHash: null, stellarTransactionId: null }),
        ],
      },
      links: { findById: async () => makeLink({ offrampNetTargetAmount: "9950", title: "=HYPERLINK(secret)" }) },
      horizon: horizon(),
    });
    return svc.generateReport({ from: 0, to: 1 });
  }

  it("CSV quotes every cell, has a header and a row per job, and neutralises formula triggers", async () => {
    const r = await report();
    r.items[1]!.detail = "=cmd|' /C calc'!A0";
    const csv = formatReportAsCsv(r);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"job_id"');
    expect(csv).toContain(`"'=cmd`);
  });

  it("carries no seller PII, payout fields, link titles, memos or tokens", async () => {
    const r = await report();
    const all = formatReportAsCsv(r) + formatReportAsText(r) + JSON.stringify(r);
    expect(all).not.toContain("HYPERLINK");
    expect(all).not.toContain("4242");
    expect(all).not.toMatch(/payout_fields|token|jwt|bearer|email|bank/i);
  });

  it("text summary lists only the jobs needing attention", async () => {
    const text = formatReportAsText(await report());
    expect(text).toContain("Withdrawals: 2");
    expect(text).toContain("[no_transfer] job wd_bad");
    expect(text).not.toContain("job wd_ok");
  });
});

describe("createHorizonLookup", () => {
  const opsBody = {
    _embedded: {
      records: [
        { type: "create_account" },
        { type: "payment", from: SELLER, to: ANCHOR, amount: "10.0000000", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER" },
        { type: "payment", source_account: SELLER, to: ANCHOR, amount: "1.5", asset_type: "native" },
      ],
    },
  };

  it("reads a transaction and its payment operations from Horizon", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith(`/transactions/${HASH}`)) return Response.json({ successful: true, memo_type: "id", memo: "4242", secret: "x" });
      return Response.json(opsBody);
    }) as unknown as typeof fetch;
    const h = createHorizonLookup("https://horizon.example/", fetchImpl);
    expect(await h.getTransaction(HASH)).toEqual({ successful: true, memoType: "id", memo: "4242" });
    expect(await h.getPayments(HASH)).toEqual([
      { from: SELLER, to: ANCHOR, amount: "10.0000000", asset: USDC },
      { from: SELLER, to: ANCHOR, amount: "1.5", asset: { code: "XLM", issuer: null } },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(`https://horizon.example/transactions/${HASH}`, expect.anything());
  });

  it("maps 404 to null and any other failure to an error that carries only the status", async () => {
    const notFound = createHorizonLookup("https://h", (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch);
    expect(await notFound.getTransaction(HASH)).toBeNull();
    const broken = createHorizonLookup("https://h", (async () => new Response("<html>secret body</html>", { status: 502 })) as unknown as typeof fetch);
    await expect(broken.getTransaction(HASH)).rejects.toThrow("Horizon answered HTTP 502");
    await expect(broken.getTransaction(HASH)).rejects.not.toThrow(/secret/);
  });

  it("refuses to build a URL from a malformed hash", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const h = createHorizonLookup("https://h", fetchImpl);
    await expect(h.getTransaction("../accounts")).rejects.toThrow(/malformed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
