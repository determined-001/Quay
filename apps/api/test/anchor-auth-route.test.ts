import { describe, expect, it } from "vitest";
import { AnchorChallengeError, type SellerAnchorAuth } from "@checkout/offramp";
import type { AnchorCustomer } from "@checkout/core";
import { anchorAuthRoutes } from "../src/routes/anchor-auth";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";

/**
 * The seller's anchor session is theirs alone: the routes resolve the seller
 * from their own credentials, and are gated by the scope that moves money.
 */
describe("anchorAuthRoutes", () => {
  async function harness(scopes: ApiKeyScope[], anchorAuth: Partial<SellerAnchorAuth> | null = null) {
    const container = await createTestContainer();
    const app = anchorAuthRoutes({ ...container, anchorAuth } as unknown as Container);
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
