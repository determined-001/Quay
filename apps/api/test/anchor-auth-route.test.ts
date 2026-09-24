import { describe, expect, it } from "vitest";
import { anchorAuthRoutes } from "../src/routes/anchor-auth";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";

/**
 * The seller's anchor session is theirs alone: the routes resolve the seller
 * from their own credentials, and are gated by the scope that moves money.
 */
describe("anchorAuthRoutes", () => {
  async function harness(scopes: ApiKeyScope[]) {
    const container = await createTestContainer();
    const app = anchorAuthRoutes(container as unknown as Container);
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
});
