import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { kycRoutes } from "../src/routes/kyc";
import { kycDisclosureFields, sellerKyc } from "../src/db/schema";
import { createTestContainer } from "./setup";
import { generateApiKey, hashApiKey } from "../src/services/api-keys";

describe("GET /seller/kyc/disclosures", () => {
  it("requires a seller session, not an API key", async () => {
    const c = await createTestContainer();
    try {
      const { plaintext, prefix } = generateApiKey("test");
      await c.apiKeys.create({ sellerId: c.seller.id, name: "disclosure test", prefix,
        hash: await hashApiKey(plaintext), scopes: ["offramp:initiate"] });
      const app = kycRoutes(c);
      expect((await app.request("/disclosures")).status).toBe(401);
      expect((await app.request("/disclosures", { headers: { authorization: `Bearer ${plaintext}` } })).status).toBe(403);
      expect((await app.request("/disclosures/testanchor.stellar.org", {
        method: "DELETE", headers: { authorization: `Bearer ${plaintext}` },
      })).status).toBe(403);
    } finally {
      c.client.close();
    }
  });

  it("returns only this seller's sent field names and metadata, never stored values or anchor errors", async () => {
    const c = await createTestContainer();
    try {
      const other = await c.sellers.createIfAbsent("GBV5I3B53NRJQHX4QQ52QYXDFZKSYHBCWPAESSEJQ7CKGWXVJQCZDGHW");
      const secret = "private-identity-value";
      const insertRecord = (sellerId: string, anchorDomain: string) => c.db.insert(sellerKyc).values({
        sellerId, anchorDomain, status: "REJECTED", requiredFields: "[]", fieldsEncrypted: secret,
        providedFieldStatus: JSON.stringify([{ name: "first_name", status: secret, error: secret }]),
        sentFields: '["first_name"]', updatedAt: Date.now(),
      });
      await insertRecord(c.seller.id, "testanchor.stellar.org");
      await insertRecord(other.id, "other.example");
      await c.db.insert(kycDisclosureFields).values([
        { sellerId: c.seller.id, anchorDomain: "testanchor.stellar.org", fieldName: "first_name", sentAt: 1234 },
        { sellerId: other.id, anchorDomain: "other.example", fieldName: "email_address", sentAt: 5678 },
      ]);
      const app = kycRoutes(c);
      const token = await c.tokenFor(c.seller.id, c.seller.wallet);
      const response = await app.request("/disclosures", { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual([{
        anchorDomain: "testanchor.stellar.org", status: "REJECTED",
        fields: [{ name: "first_name", sentAt: 1234, anchorStatus: "UNKNOWN" }], consent: null,
      }]);
      expect(JSON.stringify(json)).not.toContain(secret);
      expect(JSON.stringify(json)).not.toContain("other.example");

      const otherToken = await c.tokenFor(other.id, other.wallet);
      const otherResponse = await app.request("/disclosures", { headers: { authorization: `Bearer ${otherToken}` } });
      expect((await otherResponse.json() as Array<{ anchorDomain: string }>)[0]?.anchorDomain).toBe("other.example");
    } finally {
      c.client.close();
    }
  });

  it("records successful sends and erases the configured anchor's data after deletion", async () => {
    const c = await createTestContainer();
    try {
      let deletes = 0;
      c.kyc = {
        async status() { return { requiredFields: [{ name: "first_name", optional: false }], providedFields: {}, sentFields: [] }; },
        async submit() { return { requiredFields: [], providedFields: { first_name: "secret" }, sentFields: ["first_name"] }; },
      } as unknown as typeof c.kyc;
      c.kycConsents.active = async () => ({ fields: ["first_name"] }) as Awaited<ReturnType<typeof c.kycConsents.active>>;
      c.deleteAnchorCustomer = async () => { deletes++; return "deleted"; };
      const app = kycRoutes(c);
      const token = await c.tokenFor(c.seller.id, c.seller.wallet);
      const headers = { authorization: `Bearer ${token}` };
      const put = await app.request("/", { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ first_name: "secret" }) });
      expect(put.status).toBe(200);
      const sent = await c.db.select().from(kycDisclosureFields).where(eq(kycDisclosureFields.sellerId, c.seller.id));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.fieldName).toBe("first_name");

      const wrongAnchor = await app.request("/disclosures/other.example", { method: "DELETE", headers });
      expect(wrongAnchor.status).toBe(404);
      expect(deletes).toBe(0);
      const deleted = await app.request("/disclosures/testanchor.stellar.org", { method: "DELETE", headers });
      expect(deleted.status).toBe(200);
      expect(deletes).toBe(1);
      expect(await c.db.select().from(kycDisclosureFields)).toEqual([]);
    } finally {
      c.client.close();
    }
  });
});
