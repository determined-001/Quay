import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { linkRoutes } from "../../src/routes/links";
import { buildAuthMiddleware, type AuthVariables } from "../../src/middleware/auth";
import { idempotency } from "../../src/middleware/idempotency";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  Idempotency-Key behaviour (issue #26). The middleware sits after
//  requireSeller, so every request here is authenticated.
// ---------------------------------------------------------------------------

let container: TestContainer;
let app: Hono<{ Variables: AuthVariables }>;
let token = "";

let deferredGate: { promise: Promise<void>; resolve: () => void } | null = null;
let onEnteredDeferredHandler: (() => void) | null = null;

let errorRouteStatus = 500;
let errorRouteCalls = 0;

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono<{ Variables: AuthVariables }>();
  app.route("/links", linkRoutes(container, async (_c, next) => next()));

  const auth = buildAuthMiddleware({
    session: container.auth.session,
    sellers: container.sellers,
    revocations: container.auth.revocations,
    apiKeyRepo: container.apiKeys,
    allowedOrigins: container.auth.allowedOrigins,
  });
  const idempotent = idempotency(container.db);

  app.post("/test-deferred", auth, idempotent, async (ctx) => {
    onEnteredDeferredHandler?.();
    if (deferredGate) {
      await deferredGate.promise;
    }
    return ctx.json({ ok: true }, 200);
  });

  app.post("/test-5xx", auth, idempotent, async (ctx) => {
    errorRouteCalls++;
    if (errorRouteStatus >= 500) {
      return ctx.json({ error: "server_error", attempt: errorRouteCalls }, errorRouteStatus as 500);
    }
    return ctx.json({ ok: true, attempt: errorRouteCalls }, 200);
  });

  app.post("/other-endpoint", auth, idempotent, async (ctx) => {
    return ctx.json({ endpoint: "other", body: await ctx.req.json() }, 200);
  });

  const seller = container.seller;
  token = await container.tokenFor(seller.id, seller.wallet);
});

afterAll(() => {
  container.client.close();
});

function postTo(path: string, body: unknown, key?: string, authToken = token) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${authToken}`,
  };
  if (key) headers["idempotency-key"] = key;
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function post(body: unknown, key?: string, authToken = token) {
  return postTo("/links", body, key, authToken);
}

const LINK = { title: "Idempotent item", amount: "10", assetCode: "USDC" as const };

describe("Idempotency-Key on POST /links", () => {
  it("still creates normally when no key is supplied", async () => {
    const res = await post(LINK);
    expect(res.status).toBe(201);
  });

  it("replays a byte-identical response for the same key + same body", async () => {
    const first = await post(LINK, "key-replay-1");
    expect(first.status).toBe(201);
    const firstBody = await first.text();

    const second = await post(LINK, "key-replay-1");
    expect(second.status).toBe(201);
    expect(await second.text()).toBe(firstBody); // byte-identical
    expect(second.headers.get("idempotent-replayed")).toBe("true");
  });

  it("does not create a second link when replayed", async () => {
    await post(LINK, "key-once-1");
    const before = (await container.links.listBySeller((container.seller).id)).length;
    await post(LINK, "key-once-1");
    const after = (await container.links.listBySeller((container.seller).id)).length;
    expect(after).toBe(before);
  });

  it("rejects the same key with a different body — 409 idempotency_key_reuse", async () => {
    await post(LINK, "key-reuse-1");
    const res = await post({ ...LINK, amount: "999" }, "key-reuse-1");
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("idempotency_key_reuse");
  });

  it("treats distinct keys as distinct requests", async () => {
    const a = await post(LINK, "key-distinct-a");
    const b = await post(LINK, "key-distinct-b");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = ((await a.json()) as { link: { id: string } }).link.id;
    const idB = ((await b.json()) as { link: { id: string } }).link.id;
    expect(idA).not.toBe(idB);
  });

  it("returns 409 request_in_progress when a second request arrives while the first is in-flight", async () => {
    let resolveGate!: () => void;
    const gatePromise = new Promise<void>((r) => {
      resolveGate = r;
    });
    deferredGate = { promise: gatePromise, resolve: resolveGate };

    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    onEnteredDeferredHandler = entered;

    // Start first request
    const p1 = postTo("/test-deferred", { test: 1 }, "key-concurrent-1");

    // Wait until the first request is inside the handler awaiting the deferred promise
    await enteredPromise;

    // Second request with same key while the first is in-flight
    const res2 = await postTo("/test-deferred", { test: 1 }, "key-concurrent-1");
    expect(res2.status).toBe(409);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.error).toBe("request_in_progress");

    // Resolve the deferred gate to allow first request to finish
    deferredGate.resolve();
    const res1 = await p1;
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ ok: true });

    // Subsequent request after first request finished replays the stored response
    const res3 = await postTo("/test-deferred", { test: 1 }, "key-concurrent-1");
    expect(res3.status).toBe(200);
    expect(res3.headers.get("idempotent-replayed")).toBe("true");
  });

  it("does not store a 5xx response and runs the handler again on retry with the same key", async () => {
    errorRouteCalls = 0;
    errorRouteStatus = 500;

    // First request returns 500
    const res1 = await postTo("/test-5xx", { test: "5xx" }, "key-5xx-1");
    expect(res1.status).toBe(500);
    expect(errorRouteCalls).toBe(1);

    // Fix the endpoint to return 200
    errorRouteStatus = 200;

    // Retry with the exact same idempotency key and body
    const res2 = await postTo("/test-5xx", { test: "5xx" }, "key-5xx-1");
    expect(res2.status).toBe(200);
    expect(errorRouteCalls).toBe(2); // handler ran again
    expect(res2.headers.get("idempotent-replayed")).toBeNull();
    expect(await res2.json()).toEqual({ ok: true, attempt: 2 });

    // A further request with the same key now replays the stored 200 response
    const res3 = await postTo("/test-5xx", { test: "5xx" }, "key-5xx-1");
    expect(res3.status).toBe(200);
    expect(errorRouteCalls).toBe(2); // handler was not run again
    expect(res3.headers.get("idempotent-replayed")).toBe("true");
  });

  it("does not replay an entry older than the 24 h TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = new Date("2026-01-01T12:00:00Z");
      vi.setSystemTime(now);

      const seller = container.seller;
      const initialToken = await container.tokenFor(seller.id, seller.wallet);

      const first = await post(LINK, "key-ttl-1", initialToken);
      expect(first.status).toBe(201);
      const firstId = ((await first.json()) as { link: { id: string } }).link.id;

      // Immediately replaying within TTL replays the same link
      const immediate = await post(LINK, "key-ttl-1", initialToken);
      expect(immediate.status).toBe(201);
      expect(immediate.headers.get("idempotent-replayed")).toBe("true");
      expect(((await immediate.json()) as { link: { id: string } }).link.id).toBe(firstId);

      // Advance time past the 24h TTL (24 hours + 10 seconds)
      vi.setSystemTime(new Date(now.getTime() + 24 * 60 * 60 * 1000 + 10_000));

      // Renew session token for the advanced time
      const renewedToken = await container.tokenFor(seller.id, seller.wallet);

      // After 24h, the expired entry is swept and not replayed; handler runs again
      const expired = await post(LINK, "key-ttl-1", renewedToken);
      expect(expired.status).toBe(201);
      expect(expired.headers.get("idempotent-replayed")).toBeNull();
      const expiredId = ((await expired.json()) as { link: { id: string } }).link.id;
      expect(expiredId).not.toBe(firstId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not collide when the same key is sent to two different endpoints", async () => {
    const key = "key-namespaced-1";
    const payload = LINK;

    // Send to POST /links
    const linkRes = await post(payload, key);
    expect(linkRes.status).toBe(201);
    const linkBody = (await linkRes.json()) as { link: { id: string } };
    expect(linkBody.link.id).toBeDefined();

    // Send to POST /other-endpoint with the exact same key and body
    const otherRes = await postTo("/other-endpoint", payload, key);
    expect(otherRes.status).toBe(200);
    expect(otherRes.headers.get("idempotent-replayed")).toBeNull();
    const otherBody = (await otherRes.json()) as { endpoint: string; body: typeof LINK };
    expect(otherBody.endpoint).toBe("other");
    expect(otherBody.body).toEqual(LINK);

    // Replay both: each replays its own endpoint's response without cross-contamination
    const linkReplay = await post(payload, key);
    expect(linkReplay.status).toBe(201);
    expect(linkReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await linkReplay.json()) as { link: { id: string } }).link.id).toBe(linkBody.link.id);

    const otherReplay = await postTo("/other-endpoint", payload, key);
    expect(otherReplay.status).toBe(200);
    expect(otherReplay.headers.get("idempotent-replayed")).toBe("true");
    expect(await otherReplay.json()).toEqual(otherBody);
  });
});

