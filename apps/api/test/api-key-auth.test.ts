import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  buildAuthMiddleware,
  requireScope,
  type AuthVariables,
} from "../src/middleware/auth";
import { generateApiKey, hashApiKey, ALL_SCOPES, type ApiKeyScope } from "../src/services/api-keys";
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
});
