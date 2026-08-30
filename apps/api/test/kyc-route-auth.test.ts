import { describe, expect, it } from "vitest";
import { kycRoutes } from "../src/routes/kyc";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";
import type { KycRecord } from "@checkout/core";

/**
 * Regression, BUG-6.6.
 *
 * `kycRoutes` was mounted with no auth middleware and resolved the seller with
 * `sellers.getDefault()`. On the production configuration (`OFFRAMP=testanchor`)
 * that made `GET /seller/kyc` an unauthenticated read of the seller's decrypted
 * SEP-12 identity — the exact data `crypto/pii.ts` encrypts at rest — and
 * `PUT /seller/kyc` an unauthenticated write of that identity to the live
 * anchor. Verified against a running instance at the time: both returned 200
 * with no credentials whatsoever.
 */
describe("kycRoutes — authentication and scoping", () => {
  const record: KycRecord = {
    sellerId: "sel_x",
    customerId: "cus_1",
    status: "ACCEPTED",
    requiredFields: [],
    // Stand-in for real SEP-12 PII: legal name, address, bank account.
    providedFields: { first_name: "Ada", bank_account_number: "1234567890" },
    message: null,
    lastSyncedAt: 1,
    updatedAt: 1,
  };

  async function harness(scopes: ApiKeyScope[]) {
    const container = await createTestContainer();
    const submitted: Record<string, string>[] = [];
    const seenSellerIds: string[] = [];

    const withKyc = {
      ...container,
      kyc: {
        async status(sellerId: string) {
          seenSellerIds.push(sellerId);
          return record;
        },
        async submit(sellerId: string, fields: Record<string, string>) {
          seenSellerIds.push(sellerId);
          submitted.push(fields);
          return record;
        },
      },
    } as unknown as Container;

    const app = kycRoutes(withKyc);

    const { plaintext, prefix } = generateApiKey("test");
    const seller = await container.sellers.getDefault();
    await container.apiKeys.create({
      sellerId: seller.id,
      name: "kyc test key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes,
    });

    return { app, container: container as TestContainer, key: plaintext, seller, submitted, seenSellerIds };
  }

  it("refuses an unauthenticated read of the seller's identity", async () => {
    const { app, container, submitted } = await harness(["offramp:initiate"]);

    const res = await app.request("/");

    expect(res.status).toBe(401);
    const body = await res.text();
    // The PII must not appear anywhere in the response.
    expect(body).not.toContain("Ada");
    expect(body).not.toContain("1234567890");
    expect(submitted).toEqual([]);
    container.client.close();
  });

  it("refuses an unauthenticated write of the seller's identity", async () => {
    const { app, container, submitted } = await harness(["offramp:initiate"]);

    const res = await app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ first_name: "Mallory" }),
    });

    expect(res.status).toBe(401);
    // Nothing reached the anchor.
    expect(submitted).toEqual([]);
    container.client.close();
  });

  it("refuses an authenticated key that lacks offramp:initiate", async () => {
    const { app, container, key } = await harness(["links:read", "links:write", "webhooks:manage"]);

    const res = await app.request("/", { headers: { authorization: `Bearer ${key}` } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "missing_scope", required: "offramp:initiate" });
    container.client.close();
  });

  it("serves the authenticated seller, resolved from the token rather than getDefault()", async () => {
    const { app, container, key, seller, seenSellerIds } = await harness(["offramp:initiate"]);

    const res = await app.request("/", { headers: { authorization: `Bearer ${key}` } });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ACCEPTED" });
    expect(seenSellerIds).toEqual([seller.id]);
    container.client.close();
  });

  it("submits identity for the authenticated seller", async () => {
    const { app, container, key, seller, submitted, seenSellerIds } = await harness(["offramp:initiate"]);

    const res = await app.request("/", {
      method: "PUT",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ first_name: "Ada" }),
    });

    expect(res.status).toBe(200);
    expect(submitted).toEqual([{ first_name: "Ada" }]);
    expect(seenSellerIds).toEqual([seller.id]);
    container.client.close();
  });
});
