import { describe, expect, it } from "vitest";
import { createDb, bootstrap } from "../src/db/client";
import { DrizzleOfframpTelemetryRepository } from "../src/repos/index";
import type { OffRampTelemetryRow } from "@checkout/core";

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return new DrizzleOfframpTelemetryRepository(db);
}

function row(over: Partial<OffRampTelemetryRow> = {}): OffRampTelemetryRow {
  return {
    id: "tel_1",
    anchorDomain: "testanchor.stellar.org",
    corridor: "USDC/NGN",
    sellAsset: "stellar:USDC:GISSUER",
    sellAmount: "10",
    indicativeRate: null,
    quotedRate: "1650",
    quotedAt: 1_000,
    initiatedAt: null,
    settledAt: null,
    effectiveRate: null,
    feeAmount: null,
    status: "quoted",
    failureReason: null,
    ...over,
  };
}

describe("DrizzleOfframpTelemetryRepository", () => {
  it("upsert is keyed by id: lifecycle transitions update in place, snapshot columns stay put", async () => {
    const repo = await freshRepo();

    await repo.upsert(row({ id: "tel_job_1", status: "quoted", quotedRate: "1650" }));
    await repo.upsert(
      row({
        id: "tel_job_1",
        status: "settled",
        settledAt: 5_000,
        effectiveRate: "1635",
        feeAmount: "150",
      }),
    );

    const all = await repo.all();
    expect(all).toHaveLength(1); // updated, not duplicated
    expect(all[0]?.status).toBe("settled");
    expect(all[0]?.settledAt).toBe(5_000);
    expect(all[0]?.effectiveRate).toBe("1635");
    // quote-time snapshot was not clobbered by the settled write
    expect(all[0]?.quotedRate).toBe("1650");
  });

  it("summary computes p50/p95 settlement latency and mean spread per (anchor, corridor)", async () => {
    const repo = await freshRepo();

    for (const r of [
      row({
        id: "tel_1",
        status: "settled",
        initiatedAt: 1_000,
        settledAt: 1_100, // 100ms
        quotedRate: "1650",
        effectiveRate: "1650",
      }),
      row({
        id: "tel_2",
        status: "settled",
        initiatedAt: 1_000,
        settledAt: 1_200, // 200ms
        quotedRate: "1650",
        effectiveRate: "1635",
      }),
      row({
        id: "tel_3",
        status: "settled",
        initiatedAt: 1_000,
        settledAt: 1_900, // 900ms
        quotedRate: "1650",
        effectiveRate: "1600",
      }),
      row({
        id: "tel_4",
        status: "failed",
        failureReason: "boom",
      }),
    ]) {
      await repo.upsert(r);
    }

    const [s] = await repo.summary();
    expect(s?.anchorDomain).toBe("testanchor.stellar.org");
    expect(s?.corridor).toBe("USDC/NGN");
    expect(s?.count).toBe(4);
    expect(s?.settledCount).toBe(3);
    expect(s?.failedCount).toBe(1);
    expect(s?.latencyP50Ms).toBe(200); // nearest-rank: ceil(0.5*3)-1 = idx 1
    expect(s?.latencyP95Ms).toBe(900); // nearest-rank: ceil(0.95*3)-1 = idx 2
    // mean((1650-1650)/1650, (1650-1635)/1650, (1650-1600)/1650)
    expect(s?.meanSpread).toBeCloseTo((0 + 15 / 1650 + 50 / 1650) / 3, 6);
  });

  it("summary returns null percentiles when nothing has settled", async () => {
    const repo = await freshRepo();
    await repo.upsert(row({ id: "tel_1", status: "quoted" }));

    const [s] = await repo.summary();
    expect(s?.count).toBe(1);
    expect(s?.latencyP50Ms).toBeNull();
    expect(s?.latencyP95Ms).toBeNull();
    expect(s?.meanSpread).toBeNull();
  });
});
