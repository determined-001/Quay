import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { webhookRoutes } from "../../src/routes/webhooks";
import { rateLimit } from "../../src/middleware/rate-limit";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../../src/services/api-keys";
import { guardWebhookUrl } from "../../src/services/ssrf-guard";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  Webhook route tests
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

async function mintApiKey(
  c: TestContainer,
  scopes: ApiKeyScope[],
  sellerId = c.seller.id,
): Promise<string> {
  const { plaintext, prefix } = generateApiKey("live");
  const hash = await hashApiKey(plaintext);
  await c.apiKeys.create({
    sellerId,
    name: "test key",
    prefix,
    hash,
    scopes,
  });
  return plaintext;
}

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max: 0 }));
  app.route("/webhooks", webhookRoutes(container));
  const seller = container.seller;
  authToken = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

describe("POST /webhooks", () => {
  it("registers a webhook and returns id, url, and secret", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hooks/checkout" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toMatch(/^whk_/);
    expect(body.url).toBe("https://example.com/hooks/checkout");
    expect(body.secret).toBeTruthy();

    // Secret should be a hex string of length 48 (24 random bytes)
    expect(typeof body.secret).toBe("string");
    expect((body.secret as string).length).toBe(48);
  });

  it("returns 400 for missing url", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid url", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 422 invalid_webhook_url for a private-address URL", async () => {
    const originalGuard = container.webhookGuard;
    try {
      // Use real SSRF guard for private address detection
      container.webhookGuard = (u: string) => guardWebhookUrl(u);
      const res = await req("/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://127.0.0.1/webhook" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_webhook_url");
      expect(body.reason).toBeDefined();
    } finally {
      container.webhookGuard = originalGuard;
    }
  });
});

describe("GET /webhooks", () => {
  it("returns an empty list when no webhooks registered", async () => {
    // Create a fresh container with no webhooks
    const fresh = await createTestContainer();
    const freshApp = new Hono();
    freshApp.use("*", rateLimit({ windowMs: 60_000, max: 0 }));
    freshApp.route("/webhooks", webhookRoutes(fresh));

    // `fresh` has its own in-memory DB, so the outer token's sellerId doesn't
    // resolve against it — mint one from this container's own seller.
    const freshSeller = fresh.seller;
    const freshToken = await fresh.tokenFor(freshSeller.id, freshSeller.wallet);

    const res = await freshApp.request("/webhooks", { headers: { authorization: `Bearer ${freshToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.webhooks).toEqual([]);

    fresh.client.close();
  });

  it("lists registered webhooks without secrets", async () => {
    // Register one webhook
    await req("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook1" }),
    });

    const res = await req("/webhooks");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const hooks = body.webhooks as Array<Record<string, unknown>>;
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    for (const h of hooks) {
      expect(h.id).toMatch(/^whk_/);
      expect(h.url).toBeTruthy();
      expect(h.createdAt).toBeTypeOf("number");
      // Secrets should never be returned in the list
      expect((h as Record<string, unknown>).secret).toBeUndefined();
    }
  });
});

describe("POST /webhooks/deliveries/:id/replay", () => {
  it("re-queues a dead-lettered entry for the seller that owns it", async () => {
    const seller = container.seller;
    const hook = await container.webhooks.create({
      sellerId: seller.id,
      url: "https://example.com/replay-me",
      secret: "replay-secret-000",
    });
    const entry = await container.webhooks.enqueue({
      id: "wqe_replay_1",
      webhookId: hook.id,
      linkId: "lnk_1",
      event: "link.paid",
      payload: JSON.stringify({ event: "link.paid" }),
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    });
    await container.webhooks.updateQueueEntry(entry.id, {
      status: "dead",
      attempts: 5,
      nextAttemptAt: entry.nextAttemptAt,
      lastStatusCode: 500,
      lastError: "HTTP 500",
    });

    const res = await req(`/webhooks/deliveries/${entry.id}/replay`, { method: "POST" });
    expect(res.status).toBe(202);

    const after = await container.webhooks.findQueueEntry(entry.id);
    expect(after?.status).toBe("pending");
    // Replay gives dead/delivered entries a fresh retry budget.
    expect(after?.attempts).toBe(0);
  });

  it("preserves attempt count when replaying an already pending entry", async () => {
    const seller = container.seller;
    const hook = await container.webhooks.create({
      sellerId: seller.id,
      url: "https://example.com/replay-pending",
      secret: "replay-secret-001",
    });
    const entry = await container.webhooks.enqueue({
      id: "wqe_replay_pending",
      webhookId: hook.id,
      linkId: "lnk_1",
      event: "link.paid",
      payload: JSON.stringify({ event: "link.paid" }),
      nextAttemptAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    await container.webhooks.updateQueueEntry(entry.id, {
      status: "pending",
      attempts: 2,
      nextAttemptAt: entry.nextAttemptAt,
      lastStatusCode: 503,
      lastError: "HTTP 503",
    });

    const res = await req(`/webhooks/deliveries/${entry.id}/replay`, { method: "POST" });
    expect(res.status).toBe(202);

    const after = await container.webhooks.findQueueEntry(entry.id);
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(2);
  });

  it("does not let one seller replay another seller's delivery", async () => {
    const other = await container.sellers.createIfAbsent(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    const theirHook = await container.webhooks.create({
      sellerId: other.id,
      url: "https://example.com/not-yours",
      secret: "their-secret-0000",
    });
    const theirEntry = await container.webhooks.enqueue({
      id: "wqe_replay_2",
      webhookId: theirHook.id,
      linkId: "lnk_2",
      event: "link.paid",
      payload: JSON.stringify({ event: "link.paid" }),
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
    });
    await container.webhooks.updateQueueEntry(theirEntry.id, {
      status: "dead",
      attempts: 5,
      nextAttemptAt: theirEntry.nextAttemptAt,
      lastStatusCode: 500,
      lastError: "HTTP 500",
    });

    // Authenticated as the default seller, replaying someone else's entry.
    const res = await req(`/webhooks/deliveries/${theirEntry.id}/replay`, { method: "POST" });
    expect(res.status).toBe(404);

    const after = await container.webhooks.findQueueEntry(theirEntry.id);
    expect(after?.status).toBe("dead"); // untouched
  });

  it("returns 404 for an unknown entry", async () => {
    const res = await req("/webhooks/deliveries/wqe_nope/replay", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /webhooks/:id", () => {
  it("soft-deletes a webhook returning 204, then 404 on subsequent deletion", async () => {
    const hook = await container.webhooks.create({
      sellerId: container.seller.id,
      url: "https://example.com/hooks/to-delete",
      secret: "delete-secret-0001",
    });

    const res1 = await req(`/webhooks/${hook.id}`, { method: "DELETE" });
    expect(res1.status).toBe(204);

    // Verify it is no longer listed in active webhooks
    const listRes = await req("/webhooks");
    const listBody = (await listRes.json()) as { webhooks: Array<{ id: string }> };
    expect(listBody.webhooks.some((h) => h.id === hook.id)).toBe(false);

    // Second call gives 404
    const res2 = await req(`/webhooks/${hook.id}`, { method: "DELETE" });
    expect(res2.status).toBe(404);
    expect(((await res2.json()) as Record<string, unknown>).error).toBe("not_found");
  });

  it("returns 404 when attempting to delete another seller's webhook", async () => {
    const other = await container.sellers.createIfAbsent(
      "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSZDYQU6WNTUX2P",
    );
    const theirHook = await container.webhooks.create({
      sellerId: other.id,
      url: "https://example.com/hooks/their-hook",
      secret: "their-secret-delete",
    });

    // Authenticated as default seller, trying to delete other's webhook
    const res = await req(`/webhooks/${theirHook.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("not_found");

    // The other seller's webhook is still intact
    const stillExists = await container.webhooks.getById(theirHook.id, other.id);
    expect(stillExists).not.toBeNull();
  });

  it("returns 404 for an unknown webhook id", async () => {
    const res = await req("/webhooks/whk_nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("POST /webhooks/:id/rotate-secret", () => {
  it("rotates signing secret returning the new secret once and preserving previous secret for overlap window", async () => {
    const originalSecret = "initial-secret-000000000000000000000001";
    const hook = await container.webhooks.create({
      sellerId: container.seller.id,
      url: "https://example.com/hooks/to-rotate",
      secret: originalSecret,
    });

    const res = await req(`/webhooks/${hook.id}/rotate-secret`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(hook.id);
    expect(body.secret).toBeTruthy();
    expect(body.secret).not.toBe(originalSecret);
    expect(typeof body.secret).toBe("string");
    expect((body.secret as string).length).toBe(48);

    // Verify in database: previousSecret is retained and expires in ~24h
    const updated = await container.webhooks.getById(hook.id, container.seller.id);
    expect(updated).not.toBeNull();
    expect(updated?.previousSecretExpiresAt).toBeTypeOf("number");
    const timeLeftMs = (updated?.previousSecretExpiresAt ?? 0) - Date.now();
    // Should be close to 24h
    expect(timeLeftMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(timeLeftMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    // Verify GET /webhooks does not leak secret material
    const listRes = await req("/webhooks");
    const listBody = (await listRes.json()) as { webhooks: Array<Record<string, unknown>> };
    const listed = listBody.webhooks.find((h) => h.id === hook.id);
    expect(listed).toBeDefined();
    expect(listed?.secret).toBeUndefined();
    expect(listed?.previousSecret).toBeUndefined();
    expect(listed?.secretEncrypted).toBeUndefined();
    expect(listed?.previousSecretEncrypted).toBeUndefined();
  });

  it("returns 404 when attempting to rotate secret for another seller's webhook", async () => {
    const other = await container.sellers.createIfAbsent(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    const theirHook = await container.webhooks.create({
      sellerId: other.id,
      url: "https://example.com/hooks/other-rotate",
      secret: "their-secret-rotate",
    });

    const res = await req(`/webhooks/${theirHook.id}/rotate-secret`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("not_found");
  });

  it("returns 404 for an unknown webhook id", async () => {
    const res = await req("/webhooks/whk_nonexistent/rotate-secret", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /webhooks/:id/deliveries", () => {
  it("returns paginated delivery history with limit and cursor", async () => {
    const hook = await container.webhooks.create({
      sellerId: container.seller.id,
      url: "https://example.com/hooks/with-deliveries",
      secret: "deliv-secret-0001",
    });

    // Seed 3 deliveries
    await container.webhooks.recordDelivery({
      webhookId: hook.id,
      linkId: "lnk_1",
      event: "link.paid",
      attempt: 1,
      queueEntryId: null,
      statusCode: 200,
      ok: true,
      error: null,
    });
    await container.webhooks.recordDelivery({
      webhookId: hook.id,
      linkId: "lnk_2",
      event: "link.created",
      attempt: 1,
      queueEntryId: null,
      statusCode: 200,
      ok: true,
      error: null,
    });
    await container.webhooks.recordDelivery({
      webhookId: hook.id,
      linkId: "lnk_3",
      event: "link.cancelled",
      attempt: 1,
      queueEntryId: null,
      statusCode: 500,
      ok: false,
      error: "Internal Server Error",
    });

    // First page with limit=2
    const page1Res = await req(`/webhooks/${hook.id}/deliveries?limit=2`);
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as { deliveries: Array<{ id: string; event: string }>; nextCursor: string | null };
    expect(page1.deliveries.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();

    // Second page with cursor
    const page2Res = await req(`/webhooks/${hook.id}/deliveries?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as { deliveries: Array<{ id: string; event: string }>; nextCursor: string | null };
    expect(page2.deliveries.length).toBe(1);

    // Deliveries from page 1 and page 2 should be disjoint
    const ids1 = new Set(page1.deliveries.map((d) => d.id));
    for (const d of page2.deliveries) {
      expect(ids1.has(d.id)).toBe(false);
    }
  });

  it("still returns delivery history after the webhook has been soft-deleted", async () => {
    const hook = await container.webhooks.create({
      sellerId: container.seller.id,
      url: "https://example.com/hooks/deleted-deliveries",
      secret: "deliv-secret-0002",
    });

    await container.webhooks.recordDelivery({
      webhookId: hook.id,
      linkId: "lnk_del",
      event: "link.paid",
      attempt: 1,
      queueEntryId: null,
      statusCode: 200,
      ok: true,
      error: null,
    });

    // Delete the webhook
    const delRes = await req(`/webhooks/${hook.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    // Deliveries are still retrievable
    const res = await req(`/webhooks/${hook.id}/deliveries`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveries: Array<{ linkId: string }> };
    expect(body.deliveries.length).toBeGreaterThanOrEqual(1);
    expect(body.deliveries.some((d) => d.linkId === "lnk_del")).toBe(true);
  });

  it("returns 404 when querying deliveries for another seller's webhook", async () => {
    const other = await container.sellers.createIfAbsent(
      "GDZ44C57XG56D2P7U55J7O47G5S3E5463Q62H4W46Y6J5H5V5V5V5V5V",
    );
    const theirHook = await container.webhooks.create({
      sellerId: other.id,
      url: "https://example.com/hooks/other-deliveries",
      secret: "their-deliv-sec",
    });

    const res = await req(`/webhooks/${theirHook.id}/deliveries`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("not_found");
  });

  it("returns 404 for an unknown webhook id", async () => {
    const res = await req("/webhooks/whk_nonexistent/deliveries");
    expect(res.status).toBe(404);
  });
});

describe("Scope gate on /webhooks", () => {
  it("returns 403 missing_scope when an API key lacks webhooks:manage", async () => {
    const readOnlyKey = await mintApiKey(container, ["links:read"]);

    // Attempting GET /webhooks with read-only key
    const res = await app.request("/webhooks", {
      method: "GET",
      headers: { authorization: `Bearer ${readOnlyKey}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("missing_scope");
  });

  it("allows access when an API key has webhooks:manage", async () => {
    const manageKey = await mintApiKey(container, ["webhooks:manage"]);

    const res = await app.request("/webhooks", {
      method: "GET",
      headers: { authorization: `Bearer ${manageKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: unknown[] };
    expect(Array.isArray(body.webhooks)).toBe(true);
  });
});


describe("GET /webhooks/:id/deliveries — cursor validation", () => {
  it("returns 400 invalid_query on a malformed cursor", async () => {
    const hook = await container.webhooks.create({
      sellerId: container.seller.id,
      url: "https://example.com/deliveries-test",
      secret: "deliveries-secret-000",
    });

    const res = await req(`/webhooks/${hook.id}/deliveries?cursor=garbage!!`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_query");
  });
});
