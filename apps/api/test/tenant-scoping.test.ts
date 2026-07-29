/**
 * Cross-tenant access tests for every route (issue 6.4).
 *
 * "Done when: Seller A cannot see, cancel or cash out any object belonging
 * to seller B." This exercises the real route handlers (`linkRoutes` /
 * `webhookRoutes`) end to end via Hono's `app.request()`, through the real
 * `makeAuth` middleware and a real `LinkService` - only the repositories are
 * faked (in-memory), so this covers the actual wiring, not just the service
 * layer in isolation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type {
  ApiKey,
  ApiKeyRepository,
  CreateLinkInput,
  LinkRepository,
  OffRampJob,
  OffRampPort,
  OffRampQuote,
  PaymentLink,
  RailPort,
  Seller,
  SellerRepository,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
} from "@checkout/core";
import { XLM } from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { LinkService } from "../src/services/link-service";
import { makeAuth } from "../src/middleware/auth";
import { generateApiKey } from "../src/services/api-keys";
import { linkRoutes } from "../src/routes/links";
import { webhookRoutes } from "../src/routes/webhooks";
import type { Container } from "../src/services/container";

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

// ---------------------------------------------------------------------------
// In-memory fakes - real interface implementations, not mocks of behavior.
// ---------------------------------------------------------------------------

class FakeLinkRepo implements LinkRepository {
  private byId = new Map<string, PaymentLink>();

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const row: PaymentLink = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      title: input.title,
      amount: input.amount,
      asset: input.asset,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byId.set(row.id, row);
    return row;
  }
  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }
  async findByIdForSeller(id: string, sellerId: string): Promise<PaymentLink | null> {
    const link = this.byId.get(id);
    return link && link.sellerId === sellerId ? link : null;
  }
  async findByReference(reference: string): Promise<PaymentLink | null> {
    for (const l of this.byId.values()) if (l.reference === reference) return l;
    return null;
  }
  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }
  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.status === status);
  }
  async activeDestinations(): Promise<string[]> {
    return [...new Set([...this.byId.values()].map((l) => l.destination))];
  }
  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.destination === destination);
  }
  async save(link: PaymentLink): Promise<void> {
    this.byId.set(link.id, { ...link });
  }
  /** Test helper - seed a link directly, e.g. one already `paid`, without going through createLink. */
  seed(link: PaymentLink): void {
    this.byId.set(link.id, link);
  }
}

class FakeSellerRepo implements SellerRepository {
  constructor(private readonly sellers: Seller[]) {}
  async findById(id: string): Promise<Seller | null> {
    return this.sellers.find((s) => s.id === id) ?? null;
  }
}

class FakeWebhookRepo implements WebhookRepository {
  private hooks: Webhook[] = [];
  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = { id: `whk_${this.hooks.length + 1}`, sellerId: input.sellerId, url: input.url, secret: input.secret, createdAt: Date.now() };
    this.hooks.push(hook);
    return hook;
  }
  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.hooks.filter((h) => h.sellerId === sellerId);
  }
  async recordDelivery(_d: WebhookDelivery): Promise<void> {}
}

class FakeApiKeyRepo implements ApiKeyRepository {
  private keys: ApiKey[] = [];
  async create(input: { sellerId: string; keyHash: string }): Promise<ApiKey> {
    const key: ApiKey = { id: `key_${this.keys.length + 1}`, sellerId: input.sellerId, keyHash: input.keyHash, createdAt: Date.now() };
    this.keys.push(key);
    return key;
  }
  async findByHash(keyHash: string): Promise<ApiKey | null> {
    return this.keys.find((k) => k.keyHash === keyHash) ?? null;
  }
  async findBySeller(sellerId: string): Promise<ApiKey[]> {
    return this.keys.filter((k) => k.sellerId === sellerId);
  }
}

class FakeRail implements RailPort {
  buildRequest(input: Parameters<RailPort["buildRequest"]>[0]) {
    return {
      uri: `web+stellar:pay?destination=${input.destination}&memo=${input.reference}`,
      destination: input.destination,
      amount: input.amount,
      asset: input.asset,
      memo: input.reference,
    };
  }
  isValidDestination(a: string): boolean {
    return a.length > 0;
  }
}

class FakeOffRamp implements OffRampPort {
  readonly mode = "seller_initiated" as const;
  async quote(input: Parameters<OffRampPort["quote"]>[0]): Promise<OffRampQuote> {
    return {
      quoteId: "quote_1",
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: input.sourceAmount,
      rate: "1",
      expiresAt: Date.now() + 60_000,
    };
  }
  async initiate(input: Parameters<OffRampPort["initiate"]>[0]): Promise<OffRampJob> {
    return {
      jobId: "job_1",
      linkId: input.linkId,
      status: "pending",
      targetCurrency: input.payout.currency,
      targetAmount: "10",
      rate: "1",
    };
  }
  async status(jobId: string): Promise<OffRampJob> {
    return { jobId, linkId: "lnk_x", status: "pending", targetCurrency: "NGN", targetAmount: "10", rate: "1" };
  }
}

// ---------------------------------------------------------------------------
// Fixture: two sellers, each with their own API key and their own link.
// ---------------------------------------------------------------------------

const SELLER_A: Seller = { id: "sel_a", name: "Seller A", wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK5KQ", createdAt: 1 };
const SELLER_B: Seller = { id: "sel_b", name: "Seller B", wallet: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBFQ2Z", createdAt: 1 };

function buildFixture() {
  const links = new FakeLinkRepo();
  const sellers = new FakeSellerRepo([SELLER_A, SELLER_B]);
  const webhooks = new FakeWebhookRepo();
  const apiKeys = new FakeApiKeyRepo();

  const service = new LinkService({
    links,
    sellers,
    webhooks,
    rail: new FakeRail(),
    offramp: new FakeOffRamp(),
    stellar: STELLAR,
  });

  const auth = makeAuth({ apiKeys });

  const container = {
    service,
    links: links as unknown as Container["links"],
    sellers: sellers as unknown as Container["sellers"],
    webhooks: webhooks as unknown as Container["webhooks"],
    auth,
    config: { network: "testnet", horizonUrl: STELLAR.horizonUrl, sellerWallet: SELLER_A.wallet },
    start() {},
    async stop() {},
    getWatcherCircuitBreakerStatus: () => [],
    getWatcherMetrics: () => ({ accountsWatched: 0, tickDurationMs: 0, circuitBreakersOpen: 0, perAccountLag: new Map() }),
  } as unknown as Container;

  return { links, sellers, webhooks, apiKeys, service, container };
}

async function mintKey(apiKeys: FakeApiKeyRepo, sellerId: string): Promise<string> {
  const { raw, hash } = generateApiKey();
  await apiKeys.create({ sellerId, keyHash: hash });
  return raw;
}

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

// ---------------------------------------------------------------------------

describe("Cross-tenant access (issue 6.4)", () => {
  let fx: ReturnType<typeof buildFixture>;
  let keyA: string;
  let keyB: string;
  let linkApp: ReturnType<typeof linkRoutes>;
  let webhookApp: ReturnType<typeof webhookRoutes>;

  beforeEach(async () => {
    fx = buildFixture();
    keyA = await mintKey(fx.apiKeys, SELLER_A.id);
    keyB = await mintKey(fx.apiKeys, SELLER_B.id);
    linkApp = linkRoutes(fx.container);
    webhookApp = webhookRoutes(fx.container);
  });

  it("POST /links with no credential is rejected, not defaulted to some seller", async () => {
    const res = await linkApp.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "T", amount: "10" }),
    });
    expect(res.status).toBe(401);
  });

  it("a created link's destination is always the authenticated seller's own wallet, never client-supplied", async () => {
    const res = await linkApp.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(keyA) },
      // Even if a client tried to smuggle a destination in the body, the
      // schema doesn't accept one and the service never reads it from here.
      body: JSON.stringify({ title: "T", amount: "10" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { link: PaymentLink };
    expect(body.link.destination).toBe(SELLER_A.wallet);
    expect(body.link.sellerId).toBe(SELLER_A.id);
  });

  it("GET /links only ever returns the authenticated seller's own links", async () => {
    await linkApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyA) }, body: JSON.stringify({ title: "A1", amount: "10" }) });
    await linkApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyB) }, body: JSON.stringify({ title: "B1", amount: "10" }) });

    const resA = await linkApp.request("/", { headers: authHeader(keyA) });
    const bodyA = (await resA.json()) as { links: PaymentLink[] };
    expect(bodyA.links).toHaveLength(1);
    expect(bodyA.links[0]!.title).toBe("A1");

    const resB = await linkApp.request("/", { headers: authHeader(keyB) });
    const bodyB = (await resB.json()) as { links: PaymentLink[] };
    expect(bodyB.links).toHaveLength(1);
    expect(bodyB.links[0]!.title).toBe("B1");
  });

  it("GET /links/:id is public and returns only the minimal shape - never sellerId or destination", async () => {
    const created = await linkApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyA) }, body: JSON.stringify({ title: "A1", amount: "10" }) });
    const { link } = (await created.json()) as { link: PaymentLink };

    const res = await linkApp.request(`/${link.id}`); // no Authorization header at all
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: Record<string, unknown> };
    expect(body.link.title).toBe("A1");
    expect(body.link).not.toHaveProperty("sellerId");
    expect(body.link).not.toHaveProperty("destination");
  });

  it("GET /links/:id with seller B's credential on seller A's link falls through to the public view, not seller A's full record", async () => {
    const created = await linkApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyA) }, body: JSON.stringify({ title: "A1", amount: "10" }) });
    const { link } = (await created.json()) as { link: PaymentLink };

    const res = await linkApp.request(`/${link.id}`, { headers: authHeader(keyB) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: Record<string, unknown> };
    expect(body.link).not.toHaveProperty("sellerId");
    expect(body.link).not.toHaveProperty("destination");
  });

  it("GET /links/:id with the link's own owner's credential returns the full authenticated detail", async () => {
    const created = await linkApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyA) }, body: JSON.stringify({ title: "A1", amount: "10" }) });
    const { link } = (await created.json()) as { link: PaymentLink };

    const res = await linkApp.request(`/${link.id}`, { headers: authHeader(keyA) });
    const body = (await res.json()) as { link: PaymentLink };
    expect(body.link.sellerId).toBe(SELLER_A.id);
    expect(body.link.destination).toBe(SELLER_A.wallet);
  });

  it("seller B cannot cash out seller A's link - 404, not 403 (does not confirm existence)", async () => {
    const paidLink: PaymentLink = {
      id: "lnk_paid_a",
      reference: "ref_a",
      sellerId: SELLER_A.id,
      destination: SELLER_A.wallet,
      title: "Paid by A's buyer",
      amount: "10",
      asset: XLM,
      status: "paid",
      txHash: "tx_1",
      payer: "GBUYER",
      paidAmount: "10",
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    fx.links.seed(paidLink);

    const res = await linkApp.request(`/${paidLink.id}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(keyB) },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Link not found");

    // The actual owner can, though - proving the 404 above was tenant
    // scoping, not a bug that blocks cash-out entirely.
    const okRes = await linkApp.request(`/${paidLink.id}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeader(keyA) },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(okRes.status).toBe(200);
  });

  it("webhook routes require auth and are scoped per seller", async () => {
    const noAuth = await webhookApp.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com/hook" }) });
    expect(noAuth.status).toBe(401);

    await webhookApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyA) }, body: JSON.stringify({ url: "https://a.example.com/hook" }) });
    await webhookApp.request("/", { method: "POST", headers: { "content-type": "application/json", ...authHeader(keyB) }, body: JSON.stringify({ url: "https://b.example.com/hook" }) });

    const listA = await webhookApp.request("/", { headers: authHeader(keyA) });
    const bodyA = (await listA.json()) as { webhooks: { url: string }[] };
    expect(bodyA.webhooks).toHaveLength(1);
    expect(bodyA.webhooks[0]!.url).toBe("https://a.example.com/hook");
  });

  it("an unrecognized bearer token is rejected the same way as no token at all", async () => {
    const res = await linkApp.request("/", { headers: { authorization: "Bearer ak_live_not_a_real_key" } });
    expect(res.status).toBe(401);
  });
});
