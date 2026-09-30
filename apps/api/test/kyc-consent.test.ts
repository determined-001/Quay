import { describe, expect, it, beforeEach } from "vitest";
import { kycRoutes } from "../src/routes/kyc";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";
import { AnchorAuthRequiredError, type AnchorCustomer, type KycRecord, type KycConsent } from "@checkout/core";

describe("kycRoutes — consent endpoints (issue 4.26)", () => {
  const record: KycRecord = {
    sellerId: "sel_x",
    account: "GSELLER",
    customerId: "cus_1",
    status: "NEEDS_INFO",
    requiredFields: [
      { name: "first_name", type: "string", optional: false },
      { name: "last_name", type: "string", optional: false },
      { name: "email", type: "string", optional: true },
    ],
    providedFields: { first_name: "Ada" },
    providedFieldStatus: [],
    sentFields: [],
    message: null,
    lastSyncedAt: 1,
    updatedAt: 1,
  };

  async function harness(scopes: ApiKeyScope[], authKind: "session" | "api_key" = "api_key") {
    const container = await createTestContainer();
    const submitted: Record<string, string>[] = [];
    const consents: KycConsent[] = [];

    const withKyc = {
      ...container,
      anchorDomain: "testanchor.stellar.org",
      kyc: {
        async status(customer: AnchorCustomer) {
          return record;
        },
        async submit(customer: AnchorCustomer, fields: Record<string, string>) {
          submitted.push(fields);
          return { ...record, providedFields: { ...record.providedFields, ...fields } };
        },
      },
      kycConsents: {
        async list(sellerId: string) {
          return consents.filter((c) => c.sellerId === sellerId);
        },
        async grant(consent: Omit<KycConsent, "id">) {
          const newConsent: KycConsent = { ...consent, id: `cnc_${consents.length + 1}` };
          consents.push(newConsent);
          return newConsent;
        },
        async active(sellerId: string, anchorDomain: string) {
          return consents.find((c) => c.sellerId === sellerId && c.anchorDomain === anchorDomain && !c.revokedAt) ?? null;
        },
        async revoke(sellerId: string, anchorDomain: string) {
          const c = consents.find((c) => c.sellerId === sellerId && c.anchorDomain === anchorDomain);
          if (c) c.revokedAt = Date.now();
        },
      },
    } as unknown as Container;

    const app = kycRoutes(withKyc);

    const { plaintext, prefix } = generateApiKey("test");
    const seller = container.seller;
    await container.apiKeys.create({
      sellerId: seller.id,
      name: "kyc test key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes,
    });

    // For session auth, we need a session token
    let sessionToken: string | undefined;
    if (authKind === "session") {
      sessionToken = await container.tokenFor(seller.id, seller.wallet);
    }

    return { app, container, key: plaintext, sessionToken, seller, submitted, consents };
  }

  describe("GET /seller/kyc/consent", () => {
    it("lists consents for session-authenticated seller", async () => {
      const { app, container, sessionToken, seller, consents } = await harness(["offramp:initiate"], "session");
      const existing: KycConsent = {
        id: "cnc_1",
        sellerId: seller.id,
        anchorDomain: "testanchor.stellar.org",
        fields: ["first_name", "last_name"],
        grantedAt: Date.now(),
        revokedAt: null,
        grantedVia: "session",
        noticeVersion: "1.0",
      };
      consents.push(existing);

      const res = await app.request("/consent", { headers: { authorization: `Bearer ${sessionToken!}` } });

      expect(res.status).toBe(200);
      const body = await res.json() as { consents: KycConsent[] };
      expect(body.consents).toHaveLength(1);
      expect(body.consents[0]!.anchorDomain).toBe("testanchor.stellar.org");
      container.client.close();
    });

    it("rejects API-key auth", async () => {
      const { app, container, key } = await harness(["offramp:initiate"], "api_key");

      const res = await app.request("/consent", { headers: { authorization: `Bearer ${key}` } });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe("forbidden");
      expect(body.message).toContain("session authentication");
      container.client.close();
    });

    it("refuses unauthenticated request", async () => {
      const { app, container } = await harness(["offramp:initiate"], "api_key");

      const res = await app.request("/consent");

      expect(res.status).toBe(401);
      container.client.close();
    });
  });

  describe("POST /seller/kyc/consent", () => {
    it("grants consent for valid required fields", async () => {
      const { app, container, sessionToken, seller, consents } = await harness(["offramp:initiate"], "session");

      const res = await app.request("/consent", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken!}`, "content-type": "application/json" },
        body: JSON.stringify({ anchorDomain: "testanchor.stellar.org", fields: ["first_name", "last_name"] }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as KycConsent;
      expect(body.anchorDomain).toBe("testanchor.stellar.org");
      expect(body.fields).toEqual(["first_name", "last_name"]);
      expect(body.revokedAt).toBeNull();
      expect(consents).toHaveLength(1);
      container.client.close();
    });

    it("rejects consent for fields anchor does not require", async () => {
      const { app, container, sessionToken, consents } = await harness(["offramp:initiate"], "session");

      const res = await app.request("/consent", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken!}`, "content-type": "application/json" },
        body: JSON.stringify({ anchorDomain: "testanchor.stellar.org", fields: ["first_name", "phone_number"] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; fields: string[] };
      expect(body.error).toBe("invalid_fields");
      expect(body.fields).toContain("phone_number");
      expect(consents).toHaveLength(0);
      container.client.close();
    });

    it("rejects consent missing required fields", async () => {
      const { app, container, sessionToken } = await harness(["offramp:initiate"], "session");

      const res = await app.request("/consent", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken!}`, "content-type": "application/json" },
        body: JSON.stringify({ anchorDomain: "testanchor.stellar.org", fields: ["first_name"] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; fields: string[] };
      expect(body.error).toBe("missing_required_fields");
      expect(body.fields).toContain("last_name");
      container.client.close();
    });

    it("rejects API-key auth", async () => {
      const { app, container, key } = await harness(["offramp:initiate"], "api_key");

      const res = await app.request("/consent", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ anchorDomain: "testanchor.stellar.org", fields: ["first_name", "last_name"] }),
      });

      expect(res.status).toBe(403);
      container.client.close();
    });
  });

  describe("DELETE /seller/kyc/consent/:anchorDomain", () => {
    it("revokes consent for session-authenticated seller", async () => {
      const { app, container, sessionToken, seller, consents } = await harness(["offramp:initiate"], "session");
      const existing: KycConsent = {
        id: "cnc_1",
        sellerId: seller.id,
        anchorDomain: "testanchor.stellar.org",
        fields: ["first_name", "last_name"],
        grantedAt: Date.now(),
        revokedAt: null,
        grantedVia: "session",
        noticeVersion: "1.0",
      };
      consents.push(existing);

      const res = await app.request("/consent/testanchor.stellar.org", {
        method: "DELETE",
        headers: { authorization: `Bearer ${sessionToken!}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { revoked: boolean; anchorDomain: string; note: string };
      expect(body.revoked).toBe(true);
      expect(body.anchorDomain).toBe("testanchor.stellar.org");
      expect(body.note).toContain("does not erase data already held");
      expect(consents[0]!.revokedAt).not.toBeNull();
      container.client.close();
    });

    it("rejects API-key auth", async () => {
      const { app, container, key } = await harness(["offramp:initiate"], "api_key");

      const res = await app.request("/consent/testanchor.stellar.org", {
        method: "DELETE",
        headers: { authorization: `Bearer ${key}` },
      });

      expect(res.status).toBe(403);
      container.client.close();
    });
  });

  describe("PUT /seller/kyc — consent enforcement", () => {
    it("returns 403 consent_required when no active consent exists", async () => {
      const { app, container, key, submitted } = await harness(["offramp:initiate"], "api_key");

      const res = await app.request("/", {
        method: "PUT",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ last_name: "Lovelace" }),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; anchorDomain: string; fields: string[] };
      expect(body.error).toBe("consent_required");
      expect(body.anchorDomain).toBe("testanchor.stellar.org");
      expect(body.fields).toContain("first_name");
      expect(body.fields).toContain("last_name");
      expect(submitted).toHaveLength(0);
      container.client.close();
    });

    it("returns 403 consent_required when consent missing required field", async () => {
      const { app, container, key, submitted, consents, seller } = await harness(["offramp:initiate"], "api_key");
      consents.push({
        id: "cnc_1",
        sellerId: seller.id,
        anchorDomain: "testanchor.stellar.org",
        fields: ["first_name"], // missing last_name
        grantedAt: Date.now(),
        revokedAt: null,
        grantedVia: "session",
        noticeVersion: "1.0",
      });

      const res = await app.request("/", {
        method: "PUT",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ last_name: "Lovelace" }),
      });

      expect(res.status).toBe(403);
      const body = await res.json() as { error: string; fields: string[] };
      expect(body.error).toBe("consent_required");
      expect(body.fields).toContain("last_name");
      expect(submitted).toHaveLength(0);
      container.client.close();
    });

    it("allows submit when active consent covers all fields", async () => {
      const { app, container, key, submitted, consents, seller } = await harness(["offramp:initiate"], "api_key");
      consents.push({
        id: "cnc_1",
        sellerId: seller.id,
        anchorDomain: "testanchor.stellar.org",
        fields: ["first_name", "last_name"],
        grantedAt: Date.now(),
        revokedAt: null,
        grantedVia: "session",
        noticeVersion: "1.0",
      });

      const res = await app.request("/", {
        method: "PUT",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ last_name: "Lovelace" }),
      });

      expect(res.status).toBe(200);
      expect(submitted).toHaveLength(1);
      container.client.close();
    });
  });
});