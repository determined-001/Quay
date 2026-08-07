import { describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import {
  buildAuthMiddleware,
  requireScope,
  apiKeyRateLimitKey,
  type AuthVariables,
} from "../src/middleware/auth";
import { generateApiKey, hashApiKey, ALL_SCOPES, KEY_PREFIX_LEN, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";

/**
 * Composed auth: either a scoped API key (ak_*) or a session JWT/cookie
 * resolves to the same seller context; neither → 401 (no fallback).
 */
describe("buildAuthMiddleware — composed API-key + session auth", () => {
  function buildApp(container: TestContainer): Hono<{ Variables: AuthVariables }> {
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use(
      "*",
      buildAuthMiddleware({
        session: container.auth.session,
        sellers: container.sellers,
        revocations: container.auth.revocations,
        apiKeyRepo: container.apiKeys,
      }),
    );
    app.get("/whoami", (ctx) =>
      ctx.json({
        sellerId: ctx.get("seller").id,
        scopes: ctx.get("scopes"),
        authKind: ctx.get("authKind"),
      }),
    );
    app.get("/write", requireScope("links:write"), (ctx) => ctx.json({ ok: true }));
    return app;
  }

  async function mintKey(
    container: TestContainer,
    scopes: ApiKeyScope[],
    opts: { env?: "live" | "test"; sellerId?: string } = {},
  ): Promise<string> {
    const { plaintext, prefix } = generateApiKey(opts.env ?? "live");
    const hash = await hashApiKey(plaintext);
    const seller = await container.sellers.getDefault();
    await container.apiKeys.create({
      sellerId: opts.sellerId ?? seller.id,
      name: "test key",
      prefix,
      hash,
      scopes,
    });
    return plaintext;
  }

  it("authenticates a valid API key and grants exactly its scopes", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const raw = await mintKey(container, ["links:read"]);
    const seller = await container.sellers.getDefault();

    const res = await app.request("/whoami", { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sellerId: seller.id,
      scopes: ["links:read"],
      authKind: "api_key",
    });
    container.client.close();
  });

  it("rejects a well-formed but unknown ak_ key — 401, no fallback", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const unknown = generateApiKey("live").plaintext; // minted but never stored

    const res = await app.request("/whoami", { headers: { authorization: `Bearer ${unknown}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_api_key");
    container.client.close();
  });

  it("rejects a revoked key — 401", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const raw = await mintKey(container, ["links:read"]);
    const keys = await container.apiKeys.listBySeller((await container.sellers.getDefault()).id);
    expect(keys.length).toBeGreaterThan(0);
    await container.apiKeys.revoke(keys[0]!.id);

    const res = await app.request("/whoami", { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("invalid_api_key");
    container.client.close();
  });

  it("rejects an API key whose seller no longer exists — 401", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const raw = await mintKey(container, ["links:read"], { sellerId: "sel_gone" });

    const res = await app.request("/whoami", { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(401);
    container.client.close();
  });

  it("authenticates a session JWT and grants ALL_SCOPES", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const seller = await container.sellers.getDefault();
    const token = await container.tokenFor(seller.id, seller.wallet);

    const res = await app.request("/whoami", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sellerId: seller.id,
      scopes: [...ALL_SCOPES],
      authKind: "session",
    });
    container.client.close();
  });

  it("rejects a request with no credentials at all — 401 (no unauthenticated fallback)", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);

    const res = await app.request("/whoami");
    expect(res.status).toBe(401);
    container.client.close();
  });

  it("requireScope: 403 missing_scope when the key lacks the scope", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const raw = await mintKey(container, ["links:read"]); // no links:write

    const res = await app.request("/write", { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "missing_scope", required: "links:write" });
    container.client.close();
  });

  it("requireScope: passes when the key has the scope", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const raw = await mintKey(container, ["links:write"]);

    const res = await app.request("/write", { headers: { authorization: `Bearer ${raw}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    container.client.close();
  });

  it("requireScope: session has every scope, so no 403", async () => {
    const container = await createTestContainer();
    const app = buildApp(container);
    const seller = await container.sellers.getDefault();
    const token = await container.tokenFor(seller.id, seller.wallet);

    const res = await app.request("/write", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    container.client.close();
  });

  // Regression, BUG-6.7. `offramp:initiate` is excluded from DEFAULT_SCOPES
  // precisely because cash-out moves money, and services/api-keys.ts documents
  // that contract — but routes/links.ts never mounted requireScope for it, so a
  // key holding only the default set reached the cash-out handler and was
  // stopped by link state (409) rather than by authorization (403).
  describe("off-ramp routes enforce their scopes", () => {
    function offrampApp(container: TestContainer): Hono<{ Variables: AuthVariables }> {
      const app = new Hono<{ Variables: AuthVariables }>();
      app.use(
        "*",
        buildAuthMiddleware({
          session: container.auth.session,
          sellers: container.sellers,
          revocations: container.auth.revocations,
          apiKeyRepo: container.apiKeys,
        }),
      );
      // Mirrors the guard stack in routes/links.ts.
      app.post("/:id/cash-out", requireScope("offramp:initiate"), (ctx) => ctx.json({ reached: true }));
      app.get("/:id/cash-out/quote", requireScope("links:read"), (ctx) => ctx.json({ reached: true }));
      app.get("/:id/offramp-requirements", requireScope("links:read"), (ctx) => ctx.json({ reached: true }));
      return app;
    }

    it("a default-scope key cannot initiate a cash-out", async () => {
      const container = await createTestContainer();
      const app = offrampApp(container);
      // Exactly DEFAULT_SCOPES — what `POST /api-keys` grants when the caller
      // does not ask for anything.
      const raw = await mintKey(container, ["links:read", "links:write", "webhooks:manage"]);

      const res = await app.request("/lnk_x/cash-out", {
        method: "POST",
        headers: { authorization: `Bearer ${raw}` },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "missing_scope", required: "offramp:initiate" });
      container.client.close();
    });

    it("a key that opted into offramp:initiate reaches the handler", async () => {
      const container = await createTestContainer();
      const app = offrampApp(container);
      const raw = await mintKey(container, ["offramp:initiate"]);

      const res = await app.request("/lnk_x/cash-out", {
        method: "POST",
        headers: { authorization: `Bearer ${raw}` },
      });

      expect(res.status).toBe(200);
      container.client.close();
    });

    it("the off-ramp read routes require links:read", async () => {
      const container = await createTestContainer();
      const app = offrampApp(container);
      const raw = await mintKey(container, ["webhooks:manage"]); // no links:read

      for (const path of ["/lnk_x/cash-out/quote", "/lnk_x/offramp-requirements"]) {
        const res = await app.request(path, { headers: { authorization: `Bearer ${raw}` } });
        expect(res.status, path).toBe(403);
        expect(await res.json()).toEqual({ error: "missing_scope", required: "links:read" });
      }
      container.client.close();
    });
  });

  // Regression, BUG-6.8. apiKeyRateLimitKey used to bucket on the raw bearer
  // prefix after only a string test, so rotating the characters after
  // `ak_live_` minted a fresh bucket per request and the strict limiter was
  // bypassed entirely on link creation, cash-out and key management.
  describe("apiKeyRateLimitKey only trusts a prefix that resolves to a live key", () => {
    function keyCtx(authorization?: string): Context {
      const req = new Request("http://localhost/links", {
        method: "POST",
        headers: authorization ? { authorization } : {},
      });
      return { req: { header: (n: string) => req.headers.get(n) ?? undefined } } as unknown as Context;
    }

    it("falls back to the IP bucket for a forged prefix", async () => {
      const container = await createTestContainer();
      const keyFor = apiKeyRateLimitKey(container.apiKeys);

      const a = await keyFor(keyCtx("Bearer ak_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 0);
      const b = await keyFor(keyCtx("Bearer ak_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), 0);
      const none = await keyFor(keyCtx(), 0);

      // Two different forged prefixes must NOT produce two different buckets.
      expect(a).toBe(b);
      expect(a).toBe(none);
      expect(a.startsWith("ip:")).toBe(true);
      container.client.close();
    });

    it("buckets a real key by its own prefix", async () => {
      const container = await createTestContainer();
      const keyFor = apiKeyRateLimitKey(container.apiKeys);
      const raw = await mintKey(container, ["links:write"]);

      const bucket = await keyFor(keyCtx(`Bearer ${raw}`), 0);

      expect(bucket).toBe(`api-key:${raw.slice(0, KEY_PREFIX_LEN)}`);
      expect(bucket.startsWith("ip:")).toBe(false);
      container.client.close();
    });

    it("stops bucketing by prefix once the key is revoked", async () => {
      const container = await createTestContainer();
      const keyFor = apiKeyRateLimitKey(container.apiKeys);
      const raw = await mintKey(container, ["links:write"]);
      const seller = await container.sellers.getDefault();
      const [minted] = await container.apiKeys.listBySeller(seller.id);
      await container.apiKeys.revoke(minted!.id);

      const bucket = await keyFor(keyCtx(`Bearer ${raw}`), 0);

      expect(bucket.startsWith("ip:")).toBe(true);
      container.client.close();
    });
  });
});
