import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { links, offrampJobs, sellerKyc } from "../src/db/schema";
import {
  LEGACY_JOB_MARKER,
  applyCleanup,
  buildReport,
  formatReport,
} from "../scripts/lib/legacy-anchor-rows";

const CIPHERTEXT = "v1:deadbeef:SECRET-LOOKING-CIPHERTEXT-DO-NOT-PRINT";
const NOW = 1_800_000_000_000;

let dir: string;
let url: string;
let db: DB;
let close: () => void;

async function seedLink(id: string, status: string, sellerId = "sel_current") {
  await db.insert(links).values({
    id,
    reference: `ref_${id}`,
    sellerId,
    destination: "GDEST",
    title: id,
    amount: "10",
    assetCode: "USDC",
    status,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function seedJob(
  jobId: string,
  linkId: string,
  over: Partial<typeof offrampJobs.$inferInsert> = {},
) {
  await db.insert(offrampJobs).values({
    jobId,
    linkId,
    anchor: "testanchor",
    sellerId: "sel_current",
    account: "GSELLER",
    targetCurrency: "NGN",
    targetAmount: "100",
    rate: "1",
    status: "pending",
    createdAt: 10,
    updatedAt: 20,
    ...over,
  });
}

async function seedKyc(sellerId: string, over: Partial<typeof sellerKyc.$inferInsert> = {}) {
  await db.insert(sellerKyc).values({
    sellerId,
    anchorDomain: "anchor.example.com",
    account: "GSELLER",
    customerId: `cust_${sellerId}`,
    status: "ACCEPTED",
    requiredFields: "[]",
    fieldsEncrypted: CIPHERTEXT,
    updatedAt: 5,
    ...over,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "legacy-anchor-rows-"));
  url = `file:${join(dir, "test.db")}`;
  const created = createDb(url);
  db = created.db;
  close = () => created.client.close();
  await bootstrap(created.client);

  // Legacy: job under the shared account, link still waiting on it.
  await seedLink("l_legacy_pending", "offramp_pending");
  await seedJob("j_legacy_pending", "l_legacy_pending", { sellerId: null, account: null });
  // Legacy: only the account is NULL, and the anchor already has the transfer.
  await seedLink("l_legacy_sent", "offramp_failed");
  await seedJob("j_legacy_sent", "l_legacy_sent", {
    account: null,
    externalStatus: "pending_anchor",
    transferNotifiedAt: 15,
  });
  // Legacy and settled.
  await seedLink("l_legacy_settled", "offramp_settled");
  await seedJob("j_legacy_settled", "l_legacy_settled", {
    sellerId: null,
    account: null,
    status: "settled",
    externalStatus: "completed",
  });
  // Legacy job whose last_error is already taken.
  await seedLink("l_legacy_err", "offramp_failed");
  await seedJob("j_legacy_err", "l_legacy_err", {
    sellerId: null,
    account: null,
    lastError: "something else",
  });
  // Current: must never appear or change.
  await seedLink("l_current", "offramp_pending");
  await seedJob("j_current", "l_current");

  await seedKyc("sel_legacy_accepted", { account: null });
  await seedKyc("sel_legacy_reset", { account: null, customerId: null, status: "unsubmitted" });
  await seedKyc("sel_current");
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildReport", () => {
  it("lists exactly the legacy rows", async () => {
    const report = await buildReport(db);

    expect(report.jobs.map((j) => j.jobId).sort()).toEqual([
      "j_legacy_err",
      "j_legacy_pending",
      "j_legacy_sent",
      "j_legacy_settled",
    ]);
    expect(report.kyc.map((k) => k.sellerId).sort()).toEqual([
      "sel_legacy_accepted",
      "sel_legacy_reset",
    ]);
  });

  it("explains each legacy job", async () => {
    const byId = Object.fromEntries((await buildReport(db)).jobs.map((j) => [j.jobId, j]));

    expect(byId.j_legacy_pending).toMatchObject({
      linkStatus: "offramp_pending",
      missing: ["seller_id", "account"],
      autoFailedAsJobStateLost: true,
      fundsMayHaveBeenSent: false,
      needsReconciliation: false,
    });
    expect(byId.j_legacy_sent).toMatchObject({
      missing: ["account"],
      autoFailedAsJobStateLost: false,
      fundsMayHaveBeenSent: true,
    });
    expect(byId.j_legacy_settled).toMatchObject({
      needsReconciliation: true,
      fundsMayHaveBeenSent: true,
    });
  });

  it("reports whether a customer id is held without revealing anything", async () => {
    const byId = Object.fromEntries((await buildReport(db)).kyc.map((k) => [k.sellerId, k]));
    expect(byId.sel_legacy_accepted).toMatchObject({
      hasCustomerId: true,
      needsReset: true,
      status: "ACCEPTED",
    });
    expect(byId.sel_legacy_reset).toMatchObject({ hasCustomerId: false, needsReset: false });
  });

  it("totals the findings", async () => {
    expect((await buildReport(db)).totals).toEqual({
      legacyJobs: 4,
      autoFailedAsJobStateLost: 1,
      fundsMayHaveBeenSent: 2,
      needsReconciliation: 1,
      legacyKycRows: 2,
      kycWithCustomerId: 1,
    });
  });

  it("never prints or returns decrypted or encrypted PII", async () => {
    const report = await buildReport(db);
    const rendered = JSON.stringify(report) + formatReport(report);
    expect(rendered).not.toContain(CIPHERTEXT);
    expect(rendered).not.toContain("SECRET-LOOKING");
    // The customer id is a stored identifier; the report only says it is set.
    expect(rendered).not.toContain("cust_sel_legacy_accepted");
  });

  it("is read-only", async () => {
    const before = {
      jobs: await db.select().from(offrampJobs),
      kyc: await db.select().from(sellerKyc),
    };
    await buildReport(db);
    expect(await db.select().from(offrampJobs)).toEqual(before.jobs);
    expect(await db.select().from(sellerKyc)).toEqual(before.kyc);
  });

  it("reports nothing on a database with no legacy rows", async () => {
    const created = createDb(`file:${join(dir, "clean.db")}`);
    await bootstrap(created.client);
    const report = await buildReport(created.db);
    created.client.close();
    expect(report.jobs).toEqual([]);
    expect(report.kyc).toEqual([]);
    expect(formatReport(report)).toContain("(none)");
  });
});

describe("applyCleanup", () => {
  it("only touches legacy rows", async () => {
    const currentJobBefore = (await db.select().from(offrampJobs)).find((j) => j.jobId === "j_current");
    const currentKycBefore = (await db.select().from(sellerKyc)).find((k) => k.sellerId === "sel_current");

    const result = await applyCleanup(db, NOW);
    expect(result).toEqual({ kycReset: 1, jobsMarked: 3 });

    const jobs = await db.select().from(offrampJobs);
    expect(jobs.find((j) => j.jobId === "j_current")).toEqual(currentJobBefore);
    const kyc = await db.select().from(sellerKyc);
    expect(kyc.find((k) => k.sellerId === "sel_current")).toEqual(currentKycBefore);
  });

  it("resets legacy KYC but keeps the encrypted profile", async () => {
    await applyCleanup(db, NOW);
    const row = (await db.select().from(sellerKyc)).find((k) => k.sellerId === "sel_legacy_accepted")!;
    expect(row.customerId).toBeNull();
    expect(row.status).toBe("unsubmitted");
    expect(row.updatedAt).toBe(NOW);
    expect(row.fieldsEncrypted).toBe(CIPHERTEXT);
  });

  it("marks legacy jobs only where last_error is free and leaves everything else alone", async () => {
    const before = await db.select().from(offrampJobs);
    await applyCleanup(db, NOW);
    const after = await db.select().from(offrampJobs);

    for (const job of after) {
      const prior = before.find((b) => b.jobId === job.jobId)!;
      const { lastError: _a, ...rest } = job;
      const { lastError: _b, ...priorRest } = prior;
      expect(rest).toEqual(priorRest); // audit trail: only last_error may differ
    }
    const lastErrors = Object.fromEntries(after.map((j) => [j.jobId, j.lastError]));
    expect(lastErrors).toEqual({
      j_legacy_pending: LEGACY_JOB_MARKER,
      j_legacy_sent: LEGACY_JOB_MARKER,
      j_legacy_settled: LEGACY_JOB_MARKER,
      j_legacy_err: "something else",
      j_current: null,
    });
  });

  it("is idempotent", async () => {
    await applyCleanup(db, NOW);
    const afterFirst = {
      jobs: await db.select().from(offrampJobs),
      kyc: await db.select().from(sellerKyc),
    };

    expect(await applyCleanup(db, NOW + 1000)).toEqual({ kycReset: 0, jobsMarked: 0 });
    expect(await db.select().from(offrampJobs)).toEqual(afterFirst.jobs);
    expect(await db.select().from(sellerKyc)).toEqual(afterFirst.kyc);
  });

  it("shows reset and marked rows as done in the next report", async () => {
    await applyCleanup(db, NOW);
    const report = await buildReport(db);
    expect(report.kyc.every((k) => !k.needsReset)).toBe(true);
    expect(report.jobs.filter((j) => j.markable)).toEqual([]);
    expect(report.jobs.filter((j) => j.marked)).toHaveLength(3);
  });
});

describe("report-legacy-anchor-rows script", () => {
  const script = join(__dirname, "..", "scripts", "report-legacy-anchor-rows.ts");
  const run = (...args: string[]) => {
    try {
      const stdout = execFileSync("node", ["--import", "tsx", script, ...args], {
        env: { ...process.env, DATABASE_URL: url, DATABASE_AUTH_TOKEN: "" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  };

  it("dry-runs by default and writes nothing", async () => {
    const out = run();
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("dry run");
    expect(out.stdout).not.toContain(CIPHERTEXT);
    expect((await db.select().from(offrampJobs)).find((j) => j.jobId === "j_legacy_pending")!.lastError).toBeNull();
  }, 120_000);

  it("refuses --apply without --confirm", async () => {
    const out = run("--apply");
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--confirm");
    expect((await db.select().from(sellerKyc)).find((k) => k.sellerId === "sel_legacy_accepted")!.customerId).not.toBeNull();
  }, 120_000);

  it("emits parseable JSON and applies with --apply --confirm", async () => {
    const dry = run("--json");
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout).totals.legacyJobs).toBe(4);

    const applied = run("--json", "--apply", "--confirm");
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).applied).toEqual({ kycReset: 1, jobsMarked: 3 });
    expect((await db.select().from(sellerKyc)).find((k) => k.sellerId === "sel_legacy_accepted")!.customerId).toBeNull();
  }, 120_000);
});
