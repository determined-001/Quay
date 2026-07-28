import { describe, expect, it } from "vitest";
import type { PaymentLink, Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import type { Container } from "../src/services/container";
import { SessionIssuer } from "../src/services/session";
import { linkRoutes } from "../src/routes/links";

const owner: Seller = { id: "sel_owner", name: "Owner", wallet: "GOWNER", createdAt: Date.now() };
const other: Seller = { id: "sel_other", name: "Other", wallet: "GOTHER", createdAt: Date.now() };

const ownedLink: PaymentLink = {
  id: "lnk_1",
  reference: "ref_1",
  sellerId: owner.id,
  destination: owner.wallet,
  title: "T-shirt",
  amount: "10",
  asset: { code: "USDC", issuer: "GISSUER" },
  status: "active",
  txHash: null,
  payer: null,
  paidAmount: null,
  offrampJobId: null,
  offrampTargetCurrency: null,
  offrampStatus: null,
  expiresAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function fakeContainer(): Container {
  const sellersById = new Map([[owner.id, owner], [other.id, other]]);
  const sellers: SellerRepository = {
    getDefault: async () => owner,
    findById: async (id) => sellersById.get(id) ?? null,
    findByWallet: async () => null,
    createIfAbsent: async () => owner,
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
      createLink: async () => ({ link: ownedLink, request: {} as any }),
      listLinks: async () => [ownedLink],
    } as unknown as Container["service"],
    links: {} as Container["links"],
    sellers: sellers as unknown as Container["sellers"],
    webhooks: {} as Container["webhooks"],
    config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: owner.wallet },
    auth: { session, sellers, revocations } as unknown as Container["auth"],
    start() {},
    stop() {},
  };
}

async function tokenFor(session: SessionIssuer, sellerId: string): Promise<string> {
  const { token } = await session.issue({ sub: "GSUB", sellerId });
  return token;
}

describe("GET /links/:id — auth semantics", () => {
  it("rejects with 401 when no token is provided", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container);
    const res = await app.request(`/${ownedLink.id}`);
    expect(res.status).toBe(401);
  });

  it("returns the link (200) when the owning seller is authenticated", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container);
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/${ownedLink.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("rejects with 403 when a different authenticated seller requests someone else's link", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container);
    const token = await tokenFor(container.auth.session, other.id);

    const res = await app.request(`/${ownedLink.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });

  it("returns 404 for a nonexistent link even when authenticated", async () => {
    const container = fakeContainer();
    const app = linkRoutes(container);
    const token = await tokenFor(container.auth.session, owner.id);

    const res = await app.request(`/lnk_does_not_exist`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
});
