import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { linkRoutes } from "../../src/routes/links";
import { rateLimit } from "../../src/middleware/rate-limit";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  Link route tests — exercised over Hono's app.request(), no network.
// ---------------------------------------------------------------------------

let container: TestContainer;
let app: Hono;

/** Every /links and /webhooks route is seller-gated since #79, so route tests
 *  authenticate as the default seller. `GET /links/:id` is public but sending
 *  the header there is harmless. */
let authToken = "";
async function req(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${authToken}` },
  });
}

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max: 0 }));
  app.route("/links", linkRoutes(container, async (_c, next) => next()));
  const seller = container.seller;
  authToken = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

// ---------------------------------------------------------------------------
//  POST /links — create a payment link
// ---------------------------------------------------------------------------

describe("POST /links", () => {
  it("creates a link with valid body and returns 201", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Test item", amount: "25.50", assetCode: "USDC" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.link).toBeDefined();
    expect(body.request).toBeDefined();
    expect((body.link as Record<string, unknown>).id).toMatch(/^lnk_/);
    expect((body.link as Record<string, unknown>).status).toBe("active");
    expect((body.link as Record<string, unknown>).amount).toBe("25.5");
    expect((body.request as Record<string, unknown>).uri).toContain("web+stellar:pay");
  });

  it("creates a link with XLM asset", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "XLM item", amount: "100", assetCode: "XLM" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    const link = body.link as Record<string, unknown>;
    expect((link.asset as Record<string, unknown>).code).toBe("XLM");
    expect((link.asset as Record<string, unknown>).issuer).toBeNull();
  });

  it("returns 400 for missing title", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "10" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid amount", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad", amount: "-5" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty title", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", amount: "10" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("creates a link with expiresInMinutes", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Timed", amount: "10", expiresInMinutes: 60 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    const link = body.link as Record<string, unknown>;
    expect(link.expiresAt).toBeTypeOf("number");
    expect((link.expiresAt as number)).toBeGreaterThan(Date.now());
  });

  // A caller must never get to choose a link id. `demo_mug_123` was briefly
  // going to be seedable this way; the /demo page reads the real id from
  // GET /demo/link instead, so there is no reason to accept one — and a
  // predictable id on a payment link is a bad thing to be able to request.
  it("ignores a caller-supplied id — link ids are always server-generated lnk_…", async () => {
    const res = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Guessable", amount: "10", isDemo: true, id: "guessable_id" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    const id = (body.link as Record<string, unknown>).id as string;
    expect(id).not.toBe("guessable_id");
    expect(id).toMatch(/^lnk_/);
  });
});

// ---------------------------------------------------------------------------
//  GET /links — list links
// ---------------------------------------------------------------------------

describe("GET /links", () => {
  it("returns an array of links", async () => {
    await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "List test", amount: "50" }),
    });

    const res = await req("/links");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body.links)).toBe(true);
    expect((body.links as Array<unknown>).length).toBeGreaterThanOrEqual(1);
  });

  it("returns links sorted newest-first", async () => {
    const res = await req("/links");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const links = body.links as Array<Record<string, unknown>>;
    if (links.length >= 2) {
      expect((links[0]!.createdAt as number)).toBeGreaterThanOrEqual(links[1]!.createdAt as number);
    }
  });
});

// ---------------------------------------------------------------------------
//  GET /links/:id — get single link
// ---------------------------------------------------------------------------

describe("GET /links/:id", () => {
  it("returns a link by id", async () => {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Get me", amount: "30" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const res = await req(`/links/${linkId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect((body.link as Record<string, unknown>).id).toBe(linkId);
    expect(body.request).toBeDefined();
  });

  it("returns 404 for unknown id", async () => {
    const res = await req("/links/lnk_nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  // Regression, BUG-4.15. This route is public — the link id is the bearer
  // capability — and it used to return the stored row verbatim, so anyone with
  // a link id could read the seller's realized FX rate, the indicative-vs-firm
  // spread and the anchor fees, plus the internal sellerId.
  it("does not leak seller identity or off-ramp economics to an unauthenticated caller", async () => {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Projection", amount: "12.34" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const res = await req(`/links/${linkId}`);
    const body = await res.json() as { link: Record<string, unknown> };
    const keys = Object.keys(body.link);

    expect(keys).not.toContain("sellerId");
    expect(keys.filter((k) => k.startsWith("offramp"))).toEqual([]);

    // Still carries everything the checkout page and widget render.
    for (const needed of ["id", "reference", "destination", "title", "amount", "asset", "status", "txHash", "paidAmount", "expiresAt"]) {
      expect(keys, `missing ${needed}`).toContain(needed);
    }
  });
});

// ---------------------------------------------------------------------------
//  POST /links/:id/cash-out — trigger cash-out
// ---------------------------------------------------------------------------

describe("POST /links/:id/cash-out", () => {
  async function createAndPayLink(): Promise<string> {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cash-out test", amount: "10" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const link = await container.links.findById(linkId);
    if (link) {
      link.status = "paid";
      link.txHash = `tx_cashout_${linkId}`;
      link.payer = "GBUYER";
      link.paidAmount = "10";
      await container.links.save(link);
    }
    return linkId;
  }

  it("returns 409 when link is not paid", async () => {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cash-out test", amount: "10" }),
    });
    const created = await createRes.json() as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const res = await req(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain("must be paid");
  });

  it("returns 404 when link does not exist", async () => {
    const res = await req("/links/lnk_nonexistent/cash-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: "NGN" }),
    });
    expect(res.status).toBe(404);
  });

  // safeJson catches JSON parse errors and returns {}; cashOutSchema has defaults
  // so {} passes validation. Test schema failure with a non-conforming value instead.
  it("returns 400 when body field has wrong type", async () => {
    const linkId = await createAndPayLink();

    const res = await req(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetCurrency: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_body");
  });

  it("triggers cash-out successfully for a paid link", async () => {
    const linkId = await createAndPayLink();

    const res = await req(`/links/${linkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetCurrency: "NGN",
        payoutFields: { bank: "GTBank", account: "1234567890" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.job).toBeDefined();
    expect((body.job as Record<string, unknown>).status).toBe("pending");

    const updated = await container.links.findById(linkId);
    expect(updated?.status).toBe("offramp_pending");
    expect(updated?.offrampJobId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
//  GET /links/:id/cash-out/quote — firm gross/fee/net preview (issue 1.5)
// ---------------------------------------------------------------------------

describe("GET /links/:id/cash-out/quote", () => {
  async function createAndPayLink(): Promise<string> {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Quote test", amount: "10" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const link = await container.links.findById(linkId);
    if (link) {
      link.status = "paid";
      link.txHash = `tx_quote_${linkId}`;
      link.payer = "GBUYER";
      link.paidAmount = "10";
      await container.links.save(link);
    }
    return linkId;
  }

  it("returns 400 when targetCurrency is missing", async () => {
    const linkId = await createAndPayLink();
    const res = await req(`/links/${linkId}/cash-out/quote`);
    expect(res.status).toBe(400);
  });

  it("returns 409 when link is not paid", async () => {
    const createRes = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Quote test", amount: "10" }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const linkId = (created.link as Record<string, unknown>).id as string;

    const res = await req(`/links/${linkId}/cash-out/quote?targetCurrency=NGN`);
    expect(res.status).toBe(409);
  });

  it("returns 404 when link does not exist", async () => {
    const res = await req("/links/lnk_nonexistent/cash-out/quote?targetCurrency=NGN");
    expect(res.status).toBe(404);
  });

  it("returns gross, fee, and net without initiating anything (link stays paid)", async () => {
    const linkId = await createAndPayLink();

    const res = await req(`/links/${linkId}/cash-out/quote?targetCurrency=NGN`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.targetAmount).toBeDefined(); // gross
    expect(body.fee).toBeDefined();
    expect(body.netTargetAmount).toBeDefined();
    const fee = body.fee as Record<string, unknown>;
    expect(fee.source).toBeDefined();

    // Net + fee reconstructs gross.
    const gross = Number(body.targetAmount);
    const feeAmount = Number(fee.amount);
    const net = Number(body.netTargetAmount);
    expect(net + feeAmount).toBeCloseTo(gross, 6);

    // Nothing state-changing happened — the link is still just paid, no job.
    const stillPaid = await container.links.findById(linkId);
    expect(stillPaid?.status).toBe("paid");
    expect(stillPaid?.offrampJobId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  Rate-limit headers
// ---------------------------------------------------------------------------

describe("rate-limit headers", () => {
  it("includes x-ratelimit headers when rate limiter is active", async () => {
    const limitedApp = new Hono();
    limitedApp.use("*", rateLimit({ windowMs: 60_000, max: 5 }));
    limitedApp.route("/links", linkRoutes(container, async (_c, next) => next()));

    const res = await limitedApp.request("/links", { headers: { authorization: `Bearer ${authToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(res.headers.get("x-ratelimit-reset")).toBeTruthy();
  });

  it("returns 429 when rate limit exceeded", async () => {
    const limitedApp = new Hono();
    limitedApp.use("*", rateLimit({ windowMs: 60_000, max: 1 }));
    limitedApp.route("/links", linkRoutes(container, async (_c, next) => next()));

    const res1 = await limitedApp.request("/links", { headers: { authorization: `Bearer ${authToken}` } });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-ratelimit-remaining")).toBe("0");

    const res2 = await limitedApp.request("/links", { headers: { authorization: `Bearer ${authToken}` } });
    expect(res2.status).toBe(429);
    const body = await res2.json() as Record<string, unknown>;
    expect(body.error).toBe("rate_limited");
    expect(res2.headers.get("retry-after")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
//  404 fallback
// ---------------------------------------------------------------------------

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await req("/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
//  Cross-tenant isolation (issue #41)
//
//  "Seller A cannot see, cancel or cash out any object belonging to seller B."
//  Every scoped route answers 404 rather than 403 — confirming existence to a
//  stranger is itself a leak.
// ---------------------------------------------------------------------------

describe("cross-tenant isolation", () => {
  const OTHER_WALLET = "GDUY7J7A33TQWOSOQGDO776GGLM3UQERL4J3SPT56F6YS4ID7MLDERI4";
  let intruderToken = "";
  let victimLinkId = "";

  /** Same request helper, but authenticated as the *other* seller. */
  async function asIntruder(path: string, init: RequestInit = {}): Promise<Response> {
    return app.request(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${intruderToken}` },
    });
  }

  beforeAll(async () => {
    const intruder = await container.sellers.createIfAbsent(OTHER_WALLET);
    intruderToken = await container.tokenFor(intruder.id, intruder.wallet);

    const created = await req("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Victim's item", amount: "42", assetCode: "USDC" }),
    });
    expect(created.status).toBe(201);
    victimLinkId = ((await created.json()) as { link: { id: string } }).link.id;
  });

  it("does not list another seller's links", async () => {
    const res = await asIntruder("/links");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: Array<{ id: string }> };
    expect(body.links.map((l) => l.id)).not.toContain(victimLinkId);
  });

  it.each([
    ["detail", `/detail`],
    ["off-ramp preview", `/offramp-preview`],
    ["off-ramp requirements", `/offramp-requirements`],
    ["cash-out quote", `/cash-out/quote?targetCurrency=USD`],
  ])("returns 404 on GET %s for another seller's link", async (_name, suffix) => {
    const res = await asIntruder(`/links/${victimLinkId}${suffix}`);
    expect(res.status).toBe(404);
  });

  it("cannot cancel another seller's link", async () => {
    const res = await asIntruder(`/links/${victimLinkId}/cancel`, { method: "POST" });
    expect(res.status).toBe(404);

    // And the link is untouched.
    const still = await container.links.findById(victimLinkId);
    expect(still?.status).toBe("active");
  });

  it("cannot cash out another seller's link", async () => {
    const res = await asIntruder(`/links/${victimLinkId}/cash-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);

    const still = await container.links.findById(victimLinkId);
    expect(still?.offrampJobId).toBeNull();
  });

  it("keeps the public checkout read minimal — no seller identity in it", async () => {
    const res = await app.request(`/links/${victimLinkId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sellerId).toBeUndefined();
  });
});
