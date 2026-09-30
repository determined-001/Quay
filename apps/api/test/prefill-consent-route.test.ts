import { describe, expect, it } from "vitest";
import { kycRoutes } from "../src/routes/kyc";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, TEST_ANCHOR_DOMAIN, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";
import type { KycRecord, PrefillConsentRepository } from "@checkout/core";

/**
 * Issue 3.17 — SEP-24 prefill consent.
 *
 * Two things are being defended here, and they are the same thing seen from
 * two sides: this route records which field NAMES a seller agreed to share with
 * this anchor. It must therefore be as locked down as the identity routes it
 * sits beside (BUG-6.6 made `/seller/kyc` an unauthenticated read of decrypted
 * PII), and it must never carry a value — the encrypted profile in `seller_kyc`
 * is the only place values live.
 */
describe("prefill-consent routes", () => {
  const record: KycRecord = {
    sellerId: "sel_x",
    account: null,
    customerId: "cus_1",
    status: "ACCEPTED",
    requiredFields: [],
    providedFields: {
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.com",
      // Never offerable: not on the allowlist.
      id_number: "P1234567",
      photo_id_front: "data:image/png;base64,AAAA",
      // Payout detail, not identity.
      dest: "0123456789",
    },
    message: null,
    lastSyncedAt: 1,
    updatedAt: 1,
  };

  async function harness(scopes: ApiKeyScope[]) {
    const container = await createTestContainer();
    const withKyc = {
      ...container,
      kycRepo: { get: async () => record, save: async () => {} },
    } as unknown as Container;

    const app = kycRoutes(withKyc);
    const { plaintext, prefix } = generateApiKey("test");
    await container.apiKeys.create({
      sellerId: container.seller.id,
      name: "prefill test key",
      prefix,
      hash: await hashApiKey(plaintext),
      scopes,
    });

    return {
      app,
      container: container as TestContainer,
      // Non-null in the test container by construction; typed as such so these
      // tests read the row they just wrote.
      consent: container.prefillConsent as PrefillConsentRepository,
      key: plaintext,
      seller: container.seller,
    };
  }

  /** Hono's json() is `unknown` here; these tests only ever read known shapes. */
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

  const auth = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });

  it("refuses an unauthenticated read of the seller's consent", async () => {
    const { app, container } = await harness(["offramp:initiate"]);

    const res = await app.request("/prefill-consent");

    expect(res.status).toBe(401);
    container.client.close();
  });

  it("refuses an unauthenticated write of the seller's consent", async () => {
    const { app, container, consent } = await harness(["offramp:initiate"]);

    const res = await app.request("/prefill-consent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: ["first_name"] }),
    });

    expect(res.status).toBe(401);
    // Nothing was stored.
    expect(await consent.get(container.seller.id, TEST_ANCHOR_DOMAIN)).toBeNull();
    container.client.close();
  });

  it("refuses a key without offramp:initiate", async () => {
    const { app, container, key, consent } = await harness(["links:read", "links:write"]);

    const read = await app.request("/prefill-consent", { headers: { authorization: `Bearer ${key}` } });
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: "missing_scope", required: "offramp:initiate" });

    const write = await app.request("/prefill-consent", {
      method: "PUT",
      headers: auth(key),
      body: JSON.stringify({ fields: ["first_name"] }),
    });
    expect(write.status).toBe(403);

    expect(await consent.get(container.seller.id, TEST_ANCHOR_DOMAIN)).toBeNull();
    container.client.close();
  });

  it("offers only allowlisted names we hold a value for", async () => {
    const { app, container, key, consent } = await harness(["offramp:initiate"]);

    const res = await app.request("/prefill-consent", { headers: { authorization: `Bearer ${key}` } });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.anchorDomain).toBe(TEST_ANCHOR_DOMAIN);
    expect(body.fields).toEqual([]);
    expect(body.available).toEqual(["first_name", "last_name", "email_address"]);
    // Names only — no values in the response.
    const text = JSON.stringify(body);
    expect(text).not.toContain("Ada");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("0123456789");
    container.client.close();
  });

  it("stores the consented names and reads them back", async () => {
    const { app, container, key, consent } = await harness(["offramp:initiate"]);

    const put = await app.request("/prefill-consent", {
      method: "PUT",
      headers: auth(key),
      body: JSON.stringify({ fields: ["last_name", "first_name"] }),
    });
    expect(put.status).toBe(200);
    // Deduplicated and ordered, so the stored record is stable.
    expect(await json(put)).toMatchObject({ fields: ["first_name", "last_name"] });

    const get = await app.request("/prefill-consent", { headers: { authorization: `Bearer ${key}` } });
    const body = await json(get);
    expect(body.fields).toEqual(["first_name", "last_name"]);
    expect(typeof body.grantedAt).toBe("number");
    container.client.close();
  });

  it("rejects a field that is not on the allowlist, and stores nothing", async () => {
    const { app, container, key, consent } = await harness(["offramp:initiate"]);

    for (const field of ["id_number", "photo_id_front", "dest", "not_a_sep9_field"]) {
      const res = await app.request("/prefill-consent", {
        method: "PUT",
        headers: auth(key),
        body: JSON.stringify({ fields: ["first_name", field] }),
      });
      expect(res.status, field).toBe(400);
      expect((await json(res)).fields).toEqual([field]);
    }

    expect(await consent.get(container.seller.id, TEST_ANCHOR_DOMAIN)).toBeNull();
    container.client.close();
  });

  it("treats an empty list as a revocation", async () => {
    const { app, container, key, consent } = await harness(["offramp:initiate"]);

    await app.request("/prefill-consent", {
      method: "PUT",
      headers: auth(key),
      body: JSON.stringify({ fields: ["first_name"] }),
    });
    expect(await consent.get(container.seller.id, TEST_ANCHOR_DOMAIN)).not.toBeNull();

    const revoke = await app.request("/prefill-consent", {
      method: "PUT",
      headers: auth(key),
      body: JSON.stringify({ fields: [] }),
    });
    expect(revoke.status).toBe(200);
    expect(await json(revoke)).toEqual({ anchorDomain: TEST_ANCHOR_DOMAIN, fields: [], grantedAt: null });
    expect(await consent.get(container.seller.id, TEST_ANCHOR_DOMAIN)).toBeNull();
    container.client.close();
  });

  it("rejects a body that carries values rather than names", async () => {
    const { app, container, key, consent } = await harness(["offramp:initiate"]);

    const res = await app.request("/prefill-consent", {
      method: "PUT",
      headers: auth(key),
      body: JSON.stringify({ fields: { first_name: "Ada" } }),
    });

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("invalid_body");
    container.client.close();
  });

  it("scopes consent to the authenticated seller, not to whoever asks", async () => {
    const { app, container, key, consent } = await harness(["offramp:initiate"]);
    const other = await container.sellers.createIfAbsent(
      "GOTHERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );

    await app.request("/prefill-consent", {
      method: "PUT",
      headers: auth(key),
      body: JSON.stringify({ fields: ["first_name"] }),
    });

    expect(await consent.get(container.seller.id, TEST_ANCHOR_DOMAIN)).not.toBeNull();
    expect(await consent.get(other.id, TEST_ANCHOR_DOMAIN)).toBeNull();
    container.client.close();
  });
});
