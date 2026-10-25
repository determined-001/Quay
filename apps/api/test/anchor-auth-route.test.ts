import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { AnchorChallengeError, type SellerAnchorAuth } from "@checkout/offramp";
import type { AnchorCustomer } from "@checkout/core";
import { anchorAuthRoutes } from "../src/routes/anchor-auth";
import { MemoryStore, rateLimit } from "../src/middleware/rate-limit";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";

/**
 * The seller's anchor session is theirs alone: the routes resolve the seller
 * from their own credentials, and are gated by the scope that moves money.
 */
describe("anchorAuthRoutes", () => {
  const passThroughLimiter: MiddlewareHandler = async (_ctx, next) => next();

  async function harness(
    scopes: ApiKeyScope[],
    anchorAuth: Partial<SellerAnchorAuth> | null = null,
    limiter: MiddlewareHandler = passThroughLimiter,
  ) {
    const container = await createTestContainer();
    const app = anchorAuthRoutes({ ...container, anchorAuth } as unknown as Container, limiter);
    const { plaintext, prefix } = generateApiKey("test");
    await container.apiKeys.create({
      sellerId: container.seller.id,
      name: "anchor auth test key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes,
    });
    return { app, container: container as TestContainer, key: plaintext };
  }

  it("refuses an unauthenticated caller", async () => {
    const { app, container } = await harness(["offramp:initiate"]);
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/challenge", { method: "POST" })).status).toBe(401);
    container.client.close();
  });

  it("refuses a key without offramp:initiate", async () => {
    const { app, container, key } = await harness(["links:read"]);
    const res = await app.request("/", { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(403);
    container.client.close();
  });

  it("reports nothing to sign in to when the deployment has no real anchor", async () => {
    const { app, container, key } = await harness(["offramp:initiate"]);
    const res = await app.request("/", { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: false, connected: false, anchor: null, expiresAt: null });

    const challenge = await app.request("/challenge", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(challenge.status).toBe(404);
    container.client.close();
  });

  describe("with a real anchor configured", () => {
    /** Stands in for SellerAnchorAuth; records which customer each call was made for. */
    function fakeAuth(over: Partial<SellerAnchorAuth> = {}) {
      const calls: Array<{ method: string; customer?: AnchorCustomer; sellerId?: string; tx?: string }> = [];
      const auth = {
        anchorDomain: "anchor.example",
        sessionExpiry: async (customer: AnchorCustomer) => {
          calls.push({ method: "sessionExpiry", customer });
          return 1_900_000_000_000;
        },
        challenge: async (customer: AnchorCustomer) => {
          calls.push({ method: "challenge", customer });
          return { transaction: "AAAA-challenge", networkPassphrase: "Test SDF Network ; September 2015" };
        },
        complete: async (customer: AnchorCustomer, tx: string) => {
          calls.push({ method: "complete", customer, tx });
          return { expiresAt: 1_900_000_000_000 };
        },
        signOut: async (sellerId: string) => {
          calls.push({ method: "signOut", sellerId });
        },
        ...over,
      } as unknown as SellerAnchorAuth;
      return { auth, calls };
    }

    it("reports a live session for the signed-in seller's own wallet", async () => {
      const { auth, calls } = fakeAuth();
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const res = await app.request("/", { headers: { authorization: `Bearer ${key}` } });
      expect(await res.json()).toEqual({
        required: true,
        connected: true,
        anchor: "anchor.example",
        expiresAt: 1_900_000_000_000,
      });
      expect(calls[0]?.customer).toEqual({ sellerId: container.seller.id, account: container.seller.wallet });
      container.client.close();
    });

    it("reports not connected when the seller has no live session", async () => {
      const { auth } = fakeAuth({ sessionExpiry: async () => null });
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const res = await app.request("/", { headers: { authorization: `Bearer ${key}` } });
      expect(await res.json()).toMatchObject({ required: true, connected: false, expiresAt: null });
      container.client.close();
    });

    it("hands out a challenge for the seller's own account", async () => {
      const { auth, calls } = fakeAuth();
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const res = await app.request("/challenge", { method: "POST", headers: { authorization: `Bearer ${key}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ transaction: "AAAA-challenge" });
      expect(calls[0]?.customer?.account).toBe(container.seller.wallet);
      container.client.close();
    });

    it("rate-limits challenges per seller without affecting another seller", async () => {
      const { auth } = fakeAuth();
      const limiter = rateLimit({
        windowMs: 60_000,
        max: 1,
        store: new MemoryStore(),
        keyFor: (ctx) => `anchor-auth:${(ctx.get("seller") as { id: string }).id}`,
      });
      const { app, container, key } = await harness(["offramp:initiate"], auth, limiter);
      const other = await container.sellers.createIfAbsent("GOTHER-SELLER");
      const otherToken = await container.tokenFor(other.id, other.wallet);
      const headers = { authorization: `Bearer ${key}` };

      const first = await app.request("/challenge", { method: "POST", headers });
      const limited = await app.request("/challenge", { method: "POST", headers });
      const independent = await app.request("/challenge", {
        method: "POST",
        headers: { authorization: `Bearer ${otherToken}` },
      });

      expect(first.status).toBe(200);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });
      expect(independent.status).toBe(200);
      container.client.close();
    });

    it("rate-limits challenge completion per seller without affecting another seller", async () => {
      const { auth } = fakeAuth();
      const limiter = rateLimit({
        windowMs: 60_000,
        max: 1,
        store: new MemoryStore(),
        keyFor: (ctx) => `anchor-auth:${(ctx.get("seller") as { id: string }).id}`,
      });
      const { app, container, key } = await harness(["offramp:initiate"], auth, limiter);
      const other = await container.sellers.createIfAbsent("GOTHER-SELLER");
      const otherToken = await container.tokenFor(other.id, other.wallet);
      const complete = (token: string, transaction: string) =>
        app.request("/", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ transaction }),
        });

      const first = await complete(key, "AAAA-first");
      const limited = await complete(key, "AAAA-second");
      const independent = await complete(otherToken, "AAAA-other");

      expect(first.status).toBe(200);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });
      expect(independent.status).toBe(200);
      container.client.close();
    });

    it("answers 502 when the anchor's challenge fails verification", async () => {
      const { auth } = fakeAuth({
        challenge: async () => {
          throw new AnchorChallengeError("not signed by the anchor's SIGNING_KEY");
        },
      });
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const res = await app.request("/challenge", { method: "POST", headers: { authorization: `Bearer ${key}` } });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "challenge_rejected" });
      container.client.close();
    });

    it("relays the signed challenge and never returns the anchor's token", async () => {
      const { auth, calls } = fakeAuth();
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const res = await app.request("/", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ transaction: "AAAA-signed" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ connected: true, anchor: "anchor.example", expiresAt: 1_900_000_000_000 });
      expect(JSON.stringify(body)).not.toMatch(/token/i);
      expect(calls[0]).toMatchObject({ method: "complete", tx: "AAAA-signed" });
      container.client.close();
    });

    it("rejects a missing transaction and a challenge signed for someone else", async () => {
      const { auth } = fakeAuth({
        complete: async () => {
          throw new AnchorChallengeError("challenge is for a different account than the signed-in seller");
        },
      });
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

      const empty = await app.request("/", { method: "POST", headers, body: "{}" });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toMatchObject({ error: "invalid_body" });

      const wrong = await app.request("/", { method: "POST", headers, body: JSON.stringify({ transaction: "AAAA" }) });
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({ error: "challenge_rejected" });
      container.client.close();
    });

    it("forgets the seller's session on DELETE", async () => {
      const { auth, calls } = fakeAuth();
      const { app, container, key } = await harness(["offramp:initiate"], auth);
      const res = await app.request("/", { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
      expect(res.status).toBe(204);
      expect(calls).toEqual([{ method: "signOut", sellerId: container.seller.id }]);
      container.client.close();
    });
  });
});

/** Issue 3.21: `?anchor=<home_domain>` picks the anchor; one enabled anchor is the default. */
describe("anchorAuthRoutes with several anchors", () => {
  const passThrough: MiddlewareHandler = async (_ctx, next) => next();

  function fakeAuth(domain: string, calls: string[]) {
    return {
      anchorDomain: domain,
      sessionExpiry: async () => (domain === "a.example" ? 1_900_000_000_000 : null),
      challenge: async () => ({ transaction: `tx-${domain}`, networkPassphrase: "net" }),
      signOut: async (sellerId: string) => void calls.push(`signOut:${domain}:${sellerId}`),
    } as unknown as SellerAnchorAuth;
  }

  async function harness(enabledDomains: string[]) {
    const container = await createTestContainer();
    const calls: string[] = [];
    const auths = new Map(["a.example", "b.example", "c.example"].map((d) => [d, fakeAuth(d, calls)]));
    const rec = (homeDomain: string) => ({ homeDomain });
    const anchors = {
      enabled: async () => enabledDomains.map(rec),
      list: async () => ["a.example", "b.example", "c.example"].map(rec),
      byDomain: async (d: string) => (auths.has(d) ? { auth: auths.get(d), record: rec(d) } : null),
    };
    const app = anchorAuthRoutes({ ...container, anchors } as unknown as Container, passThrough);
    const { plaintext, prefix } = generateApiKey("test");
    await container.apiKeys.create({
      sellerId: container.seller.id, name: "k", prefix, hash: await hashApiKey(plaintext), scopes: ["offramp:initiate"],
    });
    return { app, container: container as TestContainer, headers: { authorization: `Bearer ${plaintext}` }, calls, sellerId: container.seller.id };
  }

  it("defaults to the only enabled anchor", async () => {
    const { app, container, headers } = await harness(["a.example"]);
    const res = await app.request("/", { headers });
    expect(await res.json()).toMatchObject({ required: true, connected: true, anchor: "a.example" });
    const challenge = await app.request("/challenge", { method: "POST", headers });
    expect(await challenge.json()).toMatchObject({ transaction: "tx-a.example" });
    container.client.close();
  });

  it("with several enabled and none named, is a 400 listing the choices", async () => {
    const { app, container, headers } = await harness(["a.example", "b.example"]);
    for (const res of [await app.request("/", { headers }), await app.request("/challenge", { method: "POST", headers })]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "anchor_required", anchors: ["a.example", "b.example"] });
    }
    container.client.close();
  });

  it("?anchor= picks that anchor, case-insensitively, and refuses one that is not enabled", async () => {
    const { app, container, headers } = await harness(["a.example", "b.example"]);
    const b = await app.request("/?anchor=B.Example", { headers });
    expect(await b.json()).toMatchObject({ anchor: "b.example", connected: false });
    const c = await app.request("/?anchor=c.example", { headers });
    expect(c.status).toBe(404);
    expect(await c.json()).toMatchObject({ error: "unknown_anchor", anchors: ["a.example", "b.example"] });
    container.client.close();
  });

  it("reports nothing to sign in to when no anchor is enabled", async () => {
    const { app, container, headers } = await harness([]);
    expect(await (await app.request("/", { headers })).json()).toEqual({ required: false, connected: false, anchor: null, expiresAt: null });
    container.client.close();
  });

  it("DELETE signs out of the named anchor, or of every anchor when none is named", async () => {
    const { app, container, headers, calls, sellerId } = await harness(["a.example", "b.example"]);
    expect((await app.request("/?anchor=b.example", { method: "DELETE", headers })).status).toBe(204);
    expect(calls).toEqual([`signOut:b.example:${sellerId}`]);
    calls.length = 0;
    expect((await app.request("/", { method: "DELETE", headers })).status).toBe(204);
    expect(calls).toEqual([`signOut:a.example:${sellerId}`, `signOut:b.example:${sellerId}`, `signOut:c.example:${sellerId}`]);
    container.client.close();
  });
});
