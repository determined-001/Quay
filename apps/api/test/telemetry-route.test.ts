import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOOP_LOGGER } from "@checkout/core";
import type { Container } from "../src/services/container";
import { telemetryRoutes } from "../src/routes/telemetry";
import { FakeTelemetryRepository } from "./fakes";

function fakeContainer(): Container {
  return {
    service: {} as Container["service"],
    logger: NOOP_LOGGER,
    links: {} as Container["links"],
    sellers: {} as Container["sellers"],
    webhooks: {} as Container["webhooks"],
    apiKeys: {} as Container["apiKeys"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: "GSELLER" },
    kyc: {} as Container["kyc"],
    anchorAuth: null,
    db: {} as Container["db"],
    telemetry: new FakeTelemetryRepository(),
    auth: {} as Container["auth"],
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
    metricsToken: "test-metrics-token",
    ready: async () => true,
    watcherLagSeconds: () => 0,
    circuitBreakerState: () => 0,
    getWatcherCircuitBreakerStatus: () => [],
    getWatcherMetrics: () => ({
      accountsWatched: 0,
      tickDurationMs: 0,
      perAccountLag: new Map(),
      circuitBreakersOpen: 0,
    }),
    kycConsents: {
      async list(sellerId: string) { return []; },
      async grant(consent: any) { return { ...consent, id: "cnc_1" }; },
      async active(sellerId: string, anchorDomain: string) { return null; },
      async revoke(sellerId: string, anchorDomain: string) { },
    } as unknown as Container["kycConsents"],
    anchorDomain: "testanchor.stellar.org",
    start() {},
    stop() {},
  };
}

describe("telemetryRoutes", () => {
  const original = process.env.TELEMETRY_TOKEN;

  beforeEach(() => {
    process.env.TELEMETRY_TOKEN = "test-telemetry-token";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TELEMETRY_TOKEN;
    else process.env.TELEMETRY_TOKEN = original;
  });

  it("returns 404 when TELEMETRY_TOKEN is unset, so an unconfigured endpoint doesn't advertise itself", async () => {
    delete process.env.TELEMETRY_TOKEN;
    const app = telemetryRoutes(fakeContainer());

    expect((await app.request("/summary")).status).toBe(404);
    expect((await app.request("/export.csv")).status).toBe(404);
    expect((await app.request("/rows")).status).toBe(404);
  });

  it("rejects missing or wrong tokens with 401", async () => {
    const app = telemetryRoutes(fakeContainer());

    expect((await app.request("/summary")).status).toBe(401);
    const wrong = await app.request("/summary", { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("serves /summary with the aggregated rows", async () => {
    const container = fakeContainer();
    const app = telemetryRoutes(container);

    const res = await app.request("/summary", {
      headers: { authorization: "Bearer test-telemetry-token" },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ summary: [] });
  });

  it("serves /export.csv with the anonymised header and no seller/link identifiers", async () => {
    const container = fakeContainer();
    const app = telemetryRoutes(container);

    const res = await app.request("/export.csv", {
      headers: { authorization: "Bearer test-telemetry-token" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const body = await res.text();
    expect(body.split("\n")[0]).toBe(
      "corridor,sell_asset,sell_amount,quoted_rate,quoted_at,initiated_at,settled_at,effective_rate,fee_amount,status",
    );
  });
});

describe("telemetryRoutes /rows (issue 5.21)", () => {
  const original = process.env.TELEMETRY_TOKEN;
  beforeEach(() => {
    process.env.TELEMETRY_TOKEN = "test-telemetry-token";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TELEMETRY_TOKEN;
    else process.env.TELEMETRY_TOKEN = original;
  });

  function seededContainer(): Container {
    const container = fakeContainer();
    const repo = container.telemetry as FakeTelemetryRepository;
    const base = {
      sellAsset: "USDC",
      sellAmount: "10",
      indicativeRate: null,
      initiatedAt: 2,
      settledAt: 3,
      effectiveRate: "1500",
      feeAmount: "5",
      failureReason: null,
    } as const;
    void repo.upsert({ ...base, id: "tel_job1", anchorDomain: "mock", corridor: "USDC/NGN", quotedRate: "1550", quotedAt: 1, status: "settled" });
    void repo.upsert({ ...base, id: "tel_job2", anchorDomain: "mock", corridor: "USDC/NGN", quotedRate: "1540", quotedAt: 5, status: "settled" });
    void repo.upsert({ ...base, id: "tel_job3", anchorDomain: "testanchor.stellar.org", corridor: "USDC/USD", quotedRate: "0.98", quotedAt: 9, status: "failed" });
    return container;
  }

  it("requires the same guard as the other routes", async () => {
    const app = telemetryRoutes(seededContainer());
    expect((await app.request("/rows")).status).toBe(401);
  });

  it("returns anonymised rows, newest first, with no row/job identifier", async () => {
    const app = telemetryRoutes(seededContainer());
    const res = await app.request("/rows", {
      headers: { authorization: "Bearer test-telemetry-token" },
    });
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(rows.map((r) => r.quotedAt)).toEqual([9, 5, 1]);
    for (const row of rows) {
      expect(row.id).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain("tel_");
      expect(JSON.stringify(row)).not.toContain("job");
    }
  });

  it("filters by corridor and caps the limit", async () => {
    const app = telemetryRoutes(seededContainer());
    const res = await app.request("/rows?corridor=USDC%2FNGN&limit=1", {
      headers: { authorization: "Bearer test-telemetry-token" },
    });
    const { rows } = (await res.json()) as { rows: Array<{ corridor: string; quotedAt: number }> };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ corridor: "USDC/NGN", quotedAt: 5 });

    const capped = await app.request("/rows?limit=99999", {
      headers: { authorization: "Bearer test-telemetry-token" },
    });
    const cappedBody = (await capped.json()) as { rows: unknown[] };
    expect(cappedBody.rows.length).toBeLessThanOrEqual(100);
  });
});
