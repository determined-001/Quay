import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestContainer, TEST_SELLER_WALLET } from "./setup";
import { profileRoutes } from "../src/routes/profile";
import { ScriptedKyc } from "./fakes";
import type { KycRecord } from "@checkout/core";

describe("DELETE /seller/profile", () => {
  it("erases local data and calls downstream anchor with seller session", async () => {
    const c = await createTestContainer();
    const token = await c.tokenFor(c.seller.id, c.seller.wallet);

    // Seed KYC data, anchor sessions, payout fields
    const kycRecord: KycRecord = {
      sellerId: c.seller.id,
      account: c.seller.wallet,
      customerId: "cust_123",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: { first_name: "Alice", email: "alice@example.com" },
      message: null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (c.kycRepo) {
      await c.kycRepo.save(kycRecord);
    }
    await c.anchorSessions.save({
      sellerId: c.seller.id,
      anchorDomain: "testanchor.stellar.org",
      account: c.seller.wallet,
      token: "anchor_jwt_token",
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
    });
    await c.sellers.savePayoutFields(c.seller.id, { bank: "044", accountNumber: "1234567890" });

    // Scripted Kyc to check erase is called
    let erasedCustomer: any = null;
    const scriptedKyc = new ScriptedKyc();
    scriptedKyc.eraseImpl = async (cust) => {
      erasedCustomer = cust;
      return [{ anchorDomain: "testanchor.stellar.org", result: "erased" }];
    };
    c.kyc = scriptedKyc;

    const app = new Hono();
    app.route("/seller/profile", profileRoutes(c));

    const res = await app.request("/seller/profile", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: c.seller.wallet }),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.erased).toEqual(["profile", "kyc", "consents", "anchor_sessions", "payout_fields"]);
    expect(body.anchors).toEqual([{ anchorDomain: "testanchor.stellar.org", result: "erased" }]);
    expect(body.retained).toHaveLength(2);

    expect(erasedCustomer).toEqual({
      sellerId: c.seller.id,
      account: c.seller.wallet,
    });

    // Check local data deleted
    if (c.kycRepo) {
      const remainingKyc = await c.kycRepo.get(c.seller.id);
      expect(remainingKyc).toBeNull();
    }
    const remainingSession = await c.anchorSessions.get(c.seller.id, "testanchor.stellar.org");
    expect(remainingSession).toBeNull();
    const updatedSeller = await c.sellers.findById(c.seller.id);
    expect(updatedSeller?.payoutFields).toBeNull();
  });

  it("does not delete another seller's rows", async () => {
    const c = await createTestContainer();
    const otherSeller = await c.sellers.createIfAbsent("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

    // Seed other seller data
    if (c.kycRepo) {
      await c.kycRepo.save({
        sellerId: otherSeller.id,
        account: otherSeller.wallet,
        customerId: "cust_other",
        status: "ACCEPTED",
        requiredFields: [],
        providedFields: { first_name: "Bob" },
        message: null,
        lastSyncedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await c.anchorSessions.save({
      sellerId: otherSeller.id,
      anchorDomain: "testanchor.stellar.org",
      account: otherSeller.wallet,
      token: "other_jwt",
      expiresAt: Date.now() + 3600_000,
      createdAt: Date.now(),
    });

    const token = await c.tokenFor(c.seller.id, c.seller.wallet);
    const app = new Hono();
    app.route("/seller/profile", profileRoutes(c));

    const res = await app.request("/seller/profile", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: c.seller.wallet }),
    });

    expect(res.status).toBe(200);

    // Other seller data intact
    if (c.kycRepo) {
      const otherKyc = await c.kycRepo.get(otherSeller.id);
      expect(otherKyc).not.toBeNull();
      expect(otherKyc?.providedFields.first_name).toBe("Bob");
    }
    const otherSession = await c.anchorSessions.get(otherSeller.id, "testanchor.stellar.org");
    expect(otherSession).not.toBeNull();
  });

  it("rejects API key auth with 403", async () => {
    const c = await createTestContainer();
    const { generateApiKey, hashApiKey } = await import("../src/services/api-keys");
    const { plaintext, prefix } = generateApiKey("live");
    const hash = await hashApiKey(plaintext);
    await c.apiKeys.create({
      sellerId: c.seller.id,
      name: "test-key",
      prefix,
      hash,
      scopes: ["links:write", "links:read"],
    });

    const app = new Hono();
    app.route("/seller/profile", profileRoutes(c));

    const res = await app.request("/seller/profile", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: c.seller.wallet }),
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe("forbidden");
  });

  it("rejects mismatched confirm wallet with 400 invalid_confirmation", async () => {
    const c = await createTestContainer();
    const token = await c.tokenFor(c.seller.id, c.seller.wallet);

    const app = new Hono();
    app.route("/seller/profile", profileRoutes(c));

    const res = await app.request("/seller/profile", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "GWRONGWALLET0000000000000000000000000000000000000000000" }),
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toBe("invalid_confirmation");
  });
});
