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
    db: {} as Container["db"],
    telemetry: new FakeTelemetryRepository(),
    auth: {} as Container["auth"],
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
    metricsToken: "test-metrics-token",
    ready: async () => true,
    attestation: { enabled: false, contractId: null },
    watcherLagSeconds: () => 0,
    circuitBreakerState: () => 0,
    getWatcherCircuitBreakerStatus: () => [],
    getWatcherMetrics: () => ({
      accountsWatched: 0,
      tickDurationMs: 0,
      perAccountLag: new Map(),
      circuitBreakersOpen: 0,
    }),
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
