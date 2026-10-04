import { describe, expect, it } from "vitest";
import { NOOP_LOGGER, type PaymentLink, type Seller, type SellerRepository, type TokenRevocationRepository } from "@checkout/core";
import type { Container } from "../src/services/container";
import { SessionIssuer } from "../src/services/session";
import { linkRoutes } from "../src/routes/links";
import { HttpError } from "../src/services/link-service";

const owner: Seller = { id: "sel_owner", name: "Owner", wallet: "GOWNER", profileKind: "individual", payoutFields: null, createdAt: Date.now() };
const other: Seller = { id: "sel_other", name: "Other", wallet: "GOTHER", profileKind: "individual", payoutFields: null, createdAt: Date.now() };

const ownedLink: PaymentLink = {
  id: "lnk_1",
  reference: "ref_1",
  sellerId: owner.id,
  destination: owner.wallet,
  muxedId: null,
  title: "T-shirt",
  amount: "10",
  asset: { code: "USDC", issuer: "GISSUER" },
  status: "active",
  txHash: null,
  payer: null,
  paidAmount: null,
  overpaidAmount: null,
  offrampJobId: null,
  offrampTargetCurrency: null,
  offrampStatus: null,
  offrampIndicativeRate: null,
  offrampRate: null,
  offrampRateDelta: null,
  offrampFeeAmount: null,
  offrampFeeCurrency: null,
  offrampFeeSource: null,
  offrampNetTargetAmount: null,
  expiresAt: null,
  isDemo: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function fakeContainer(): Container {
  const sellersById = new Map([[owner.id, owner], [other.id, other]]);
  const sellers: SellerRepository = {
    findById: async (id) => sellersById.get(id) ?? null,
    findByWallet: async () => null,
    createIfAbsent: async () => owner,
    savePayoutFields: async () => {},
    saveProfileKind: async () => {},
  };
  const revocations: TokenRevocationRepository = {
    revoke: async () => {},
    isRevoked: async () => false,
    sweepExpired: async () => {},
  };
  const session = new SessionIssuer("test-secret");

  return {
    service: {
      getLink: async (id: string) => (id === ownedLink.id ? { link: ownedLink, request: {} as any } : null),
      getOffRampExternalStatus: async () => "incomplete",
      getOfframpPollStatus: async () => null,
      createLink: async () => ({ link: ownedLink, request: {} as any }),
      listLinks: async () => [ownedLink],
      cancelLink: async () => ({ ...ownedLink, status: "cancelled" as const }),
      getCashOutTransfer: async (id: string) =>
        id === ownedLink.id
          ? {
              destination: "GANCHORACCOUNT123",
              amount: "10",
              asset: { code: "USDC", issuer: "GISSUER" },
              memo: "test-memo",
              memoType: "text",
            }
          : null,
    } as unknown as Container["service"],
    logger: NOOP_LOGGER,
    links: {} as Container["links"],
    sellers: sellers as unknown as Container["sellers"],
    webhooks: { listDeliveriesByLinkId: async () => [] } as unknown as Container["webhooks"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: owner.wallet },
    auth: { session, sellers, revocations } as unknown as Container["auth"],
    apiKeys: {} as Container["apiKeys"],
    kyc: {} as Container["kyc"],
    kycConsents: {
      async list(sellerId: string) { return []; },
      async grant(consent: any) { return { ...consent, id: "cnc_1" }; },
      async active(sellerId: string, anchorDomain: string) { return null; },
      async revoke(sellerId: string, anchorDomain: string) { },
    } as unknown as Container["kycConsents"],
    anchorDomain: "testanchor.stellar.org",
    anchorAuth: null,
    db: {} as Container["db"],
    telemetry: { upsert: async () => {}, summary: async () => [], all: async () => [] } as unknown as Container["telemetry"],
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
    start() {},
    stop() {},
  };
}

async function tokenFor(session: SessionIssuer, sellerId: string): Promise<string> {
  const { token } = await session.issue({ sub: "GSUB", sellerId });
  return token;
}

describe("GET /links/:id — public checkout read", () => {
  // Deliberately NOT gated: the buyer paying an invoice holds no seller session,
  // and the checkout page is server-rendered with no cookie at all. The link id
  // is the bearer capability here.
  it("returns the link (200) to an unauthenticated buyer", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}`);
    expect(res.status).toBe(200);
  });

  it("returns the link (200) when the owning seller is authenticated", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("still serves a link to a different authenticated seller — reads are public", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a nonexistent link", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const res = await app.request(`/lnk_does_not_exist`);
    expect(res.status).toBe(404);
  });
});

describe("POST /links/:id/cancel — ownership", () => {
  it("rejects with 401 when no token is provided", async () => {
    const app = linkRoutes(fakeContainer(), async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  // 404 rather than 403 since issue #41: a 403 would confirm the link exists.
  it("rejects with 404 when a different seller tries to cancel the link", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("not_found");
  });

  it("cancels the link for its owner", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /links/:id/detail — seller reconciliation view", () => {
  it("includes the anchor-reported external status for the owner", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}/detail`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).offrampExternalStatus).toBe("incomplete");
  });

  it("returns 404 when a different seller requests the detail view", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}/detail`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /links/:id/submit — public wallet relay", () => {
  it("returns 400 for a malformed submit payload without invoking the service", async () => {
    const app = linkRoutes(fakeContainer(), async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr: 123 }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_body");
  });

  it("returns 400 for invalid JSON", async () => {
    const app = linkRoutes(fakeContainer(), async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });
});

describe("cash-out routes — offramp_rejected", () => {
  const rejection = () =>
    new HttpError(422, "offramp_rejected", {
      message: "above max",
      limits: { minAmount: 1, maxAmount: 10 },
      availableTypes: [],
    });

  function appThatRejects() {
    const container = fakeContainer();
    const service = container.service as unknown as Record<string, unknown>;
    service.quoteCashOut = async () => {
      throw rejection();
    };
    service.triggerCashOut = async () => {
      throw rejection();
    };
    return { container, app: linkRoutes(container, async (_c, next) => next()) };
  }

  it("GET /:id/cash-out/quote returns 422 with limits", async () => {
    const { container, app } = appThatRejects();
    const token = await tokenFor(container.auth.session, owner.id);
    const res = await app.request(`/${ownedLink.id}/cash-out/quote?targetCurrency=NGN`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "offramp_rejected", limits: { minAmount: 1, maxAmount: 10 } });
  });

  it("POST /:id/cash-out returns 422 with limits", async () => {
    const { container, app } = appThatRejects();
    const token = await tokenFor(container.auth.session, owner.id);
    const res = await app.request(`/${ownedLink.id}/cash-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN", payoutFields: {} }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "offramp_rejected", limits: { maxAmount: 10 } });
  });
});

describe("GET /links/:id/cash-out/transfer — non-custodial transfer instructions", () => {
  it("rejects with 401 when no token is provided", async () => {
    const app = linkRoutes(fakeContainer(), async (_c, next) => next());
    const res = await app.request(`/${ownedLink.id}/cash-out/transfer`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when requested by a different seller (IDOR protection)", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}/cash-out/transfer`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("not_found");
  });

  it("returns 404 when link does not exist", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/lnk_does_not_exist/cash-out/transfer`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns transfer instructions (200) for the owning seller", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}/cash-out/transfer`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transfer: { destination: string; amount: string; memo: string } };
    expect(body.transfer).toBeDefined();
    expect(body.transfer.destination).toBe("GANCHORACCOUNT123");
    expect(body.transfer.amount).toBe("10");
    expect(body.transfer.memo).toBe("test-memo");
  });

  it.each([
    [409, "Link must be offramp_pending to fetch transfer instructions"],
    [403, "anchor_auth_required"],
  ])("passes the service's %i through (not offramp_pending / no anchor session)", async (status, message) => {
    const container = fakeContainer();
    (container.service as unknown as Record<string, unknown>).getCashOutTransfer = async () => {
      throw new HttpError(status, message);
    };
    const app = linkRoutes(container, async (_c, next) => next());
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}/cash-out/transfer`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(status);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(message);
  });
});
