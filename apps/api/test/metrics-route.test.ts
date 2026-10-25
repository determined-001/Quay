import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { NOOP_LOGGER } from "@checkout/core";
import type { Container } from "../src/services/container";
import { metricsRoutes } from "../src/routes/metrics";
import { recordAnchorAuthRequired } from "../src/metrics";
import { createTestContainer } from "./setup";

function fakeContainer(pending: Array<{ externalStatus: string | null; count: number }> = []): Container {
  return {
    service: { webhookQueueDepth: () => 2 } as unknown as Container["service"],
    logger: NOOP_LOGGER,
    links: {
      activeDestinations: async () => ["GA...1", "GA...2"],
      listByStatus: async () => [{}, {}, {}],
      countPendingByExternalStatus: async () => pending,
    } as unknown as Container["links"],
    sellers: {} as Container["sellers"],
    webhooks: {} as Container["webhooks"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: "GSELLER" },
    metricsToken: "secret-token",
    ready: async () => true,
    watcherLagSeconds: () => 1.5,
    circuitBreakerState: () => 0,
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
    kyc: {} as Container["kyc"],
    anchorAuth: null,
    apiKeys: {} as Container["apiKeys"],
    db: {} as Container["db"],
    telemetry: { upsert: async () => {}, summary: async () => [], all: async () => [] } as unknown as Container["telemetry"],
    auth: {} as Container["auth"],
    kycConsents: {
      async list(sellerId: string) { return []; },
      async grant(consent: any) { return { ...consent, id: "cnc_1" }; },
      async active(sellerId: string, anchorDomain: string) { return null; },
      async revoke(sellerId: string, anchorDomain: string) { },
    } as unknown as Container["kycConsents"],
    anchorDomain: "testanchor.stellar.org",
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

describe("metricsRoutes", () => {
  it("rejects requests with no or wrong token", async () => {
    const app = metricsRoutes(fakeContainer());

    const noAuth = await app.request("/");
    expect(noAuth.status).toBe(401);

    const wrong = await app.request("/", { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("accepts a bearer token and returns Prometheus text with live gauges", async () => {
    const app = metricsRoutes(fakeContainer());
    const res = await app.request("/", { headers: { authorization: "Bearer secret-token" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("accounts_watched 2");
    expect(body).toContain("pending_cash_outs 3");
    expect(body).toContain("webhook_deliveries_in_flight 2");
    expect(body).toContain("watcher_lag_seconds 1.5");
  });

  it("also accepts the token via ?token=", async () => {
    const app = metricsRoutes(fakeContainer());
    const res = await app.request("/?token=secret-token");
    expect(res.status).toBe(200);
  });

  it("exports anchor_auth_required_total{route} for each bounded route", async () => {
    const routes = ["kyc_get", "kyc_put", "quote", "cash_out", "poll"] as const;
    for (const route of routes) recordAnchorAuthRequired(route);
    recordAnchorAuthRequired("poll");

    const app = metricsRoutes(fakeContainer());
    const body = await (await app.request("/", { headers: { authorization: "Bearer secret-token" } })).text();

    expect(body).toContain("# TYPE anchor_auth_required_total counter");
    for (const route of ["kyc_get", "kyc_put", "quote", "cash_out"]) {
      expect(body).toMatch(new RegExp(`anchor_auth_required_total\\{route="${route}"\\} [1-9]\\d*`));
    }
    const poll = body.match(/anchor_auth_required_total\{route="poll"\} (\d+)/);
    expect(Number(poll?.[1])).toBeGreaterThanOrEqual(2);
  });

  it("exports offramp_jobs_by_external_status and buckets unknown values as other", async () => {
    const app = metricsRoutes(
      fakeContainer([
        { externalStatus: "pending_user_transfer_start", count: 4 },
        { externalStatus: "pending_anchor", count: 2 },
        { externalStatus: "some_vendor_status", count: 1 },
        { externalStatus: "another_unknown", count: 2 },
        { externalStatus: null, count: 1 },
      ]),
    );
    const body = await (await app.request("/", { headers: { authorization: "Bearer secret-token" } })).text();

    expect(body).toContain("# TYPE offramp_jobs_by_external_status gauge");
    expect(body).toContain('offramp_jobs_by_external_status{external_status="pending_user_transfer_start"} 4');
    expect(body).toContain('offramp_jobs_by_external_status{external_status="pending_anchor"} 2');
    // 1 + 2 unrecognised + 1 NULL: three raw values, one bounded label.
    expect(body).toContain('offramp_jobs_by_external_status{external_status="other"} 4');
    expect(body).not.toContain("some_vendor_status");
    expect(body).not.toContain("another_unknown");
    // Known statuses with no jobs are written as 0 so a drained status does not keep its last value.
    expect(body).toContain('offramp_jobs_by_external_status{external_status="completed"} 0');
  });

  it("resets a status that drained between scrapes", async () => {
    const pending = [{ externalStatus: "pending_user_transfer_start" as string | null, count: 3 }];
    const app = metricsRoutes(fakeContainer(pending));
    const auth = { headers: { authorization: "Bearer secret-token" } };
    expect(await (await app.request("/", auth)).text()).toContain('{external_status="pending_user_transfer_start"} 3');
    pending.length = 0;
    expect(await (await app.request("/", auth)).text()).toContain('{external_status="pending_user_transfer_start"} 0');
  });
});

describe("DrizzleLinkRepository.countPendingByExternalStatus", () => {
  it("counts only offramp_pending links, grouped by the job's raw status", async () => {
    const container = await createTestContainer();
    const now = Date.now();
    const mk = async (id: string, status: string, externalStatus: string | null) => {
      const link = await container.links.create({
        id,
        reference: `ref_${id}`,
        sellerId: container.seller.id,
        destination: container.seller.wallet,
        muxedId: null,
        title: id,
        amount: "10",
        asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        expiresAt: null,
      });
      await container.db.run(sql`UPDATE links SET status = ${status}, offramp_job_id = ${"job_" + id} WHERE id = ${link.id}`);
      await container.db.run(
        sql`INSERT INTO offramp_jobs (job_id, link_id, anchor, target_currency, target_amount, rate, status, external_status, created_at, updated_at)
            VALUES (${"job_" + id}, ${id}, 'testanchor', 'NGN', '100', '1', 'pending', ${externalStatus}, ${now}, ${now})`,
      );
    };
    await mk("a", "offramp_pending", "pending_user_transfer_start");
    await mk("b", "offramp_pending", "pending_user_transfer_start");
    await mk("c", "offramp_pending", null);
    await mk("d", "settled", "completed");

    const rows = await container.links.countPendingByExternalStatus();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { externalStatus: "pending_user_transfer_start", count: 2 },
        { externalStatus: null, count: 1 },
      ]),
    );
    container.client.close();
  });
});
