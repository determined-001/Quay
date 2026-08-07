import { describe, expect, it } from "vitest";
import type { Container } from "../src/services/container";
import { NOOP_LOGGER, type Seller, type SellerRepository, type TokenRevocationRepository } from "@checkout/core";
import { SessionIssuer } from "../src/services/session";
import { demoRoutes } from "../src/routes/demo";

const seller: Seller = { id: "sel_1", name: "Demo Seller", wallet: "GSELLER", payoutFields: null, createdAt: Date.now() };

function fakeContainer(deleteDemo: (sellerId?: string) => Promise<number>): Container {
  const sellers: SellerRepository = {
    getDefault: async () => seller,
    findById: async (id) => (id === seller.id ? seller : null),
    findByWallet: async () => null,
    createIfAbsent: async () => seller,
    savePayoutFields: async () => {},
  };
  const revocations: TokenRevocationRepository = {
    revoke: async () => {},
    isRevoked: async () => false,
    sweepExpired: async () => {},
  };
  const session = new SessionIssuer("test-secret");

  return {
    service: {} as Container["service"],
    logger: NOOP_LOGGER,
    links: { deleteDemo } as unknown as Container["links"],
    sellers: sellers as unknown as Container["sellers"],
    webhooks: {} as Container["webhooks"],
    apiKeys: {} as Container["apiKeys"],
    telemetry: {} as Container["telemetry"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: seller.wallet },
    kyc: {} as Container["kyc"],
    db: {} as Container["db"],
    auth: { session, sellers, revocations } as unknown as Container["auth"],
    metricsToken: "test-metrics-token",
    horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
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

describe("demoRoutes", () => {
  it("rejects POST /reset without a session (401) — demo data can't be wiped anonymously", async () => {
    const app = demoRoutes(fakeContainer(async () => 0));
    const res = await app.request("/reset", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token (401)", async () => {
    const app = demoRoutes(fakeContainer(async () => 0));
    const res = await app.request("/reset", {
      method: "POST",
      headers: { authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("deletes demo rows for an authenticated seller and reports the count", async () => {
    const container = fakeContainer(async () => 5);
    const app = demoRoutes(container);
    const { token } = await container.auth.session.issue({
      sub: seller.wallet,
      sellerId: seller.id,
    });

    const res = await app.request("/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 5 });
  });

  // Regression, BUG-4.12. requireSeller only proves the caller is *a* seller,
  // and SEP-10 registration is open — any keypair holder can get a session. The
  // reset used to call deleteDemo() with no argument, wiping every seller's
  // demo rows including the seeded ones the README sends visitors to.
  it("scopes the delete to the calling seller, not every seller", async () => {
    const seen: (string | undefined)[] = [];
    const container = fakeContainer(async (sellerId) => {
      seen.push(sellerId);
      return 2;
    });
    const app = demoRoutes(container);
    const { token } = await container.auth.session.issue({
      sub: seller.wallet,
      sellerId: seller.id,
    });

    const res = await app.request("/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual([seller.id]);
    expect(seen[0]).not.toBeUndefined();
  });
});
