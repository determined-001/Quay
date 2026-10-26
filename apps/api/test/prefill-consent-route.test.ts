import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KycRecord } from "@checkout/core";
import { kycRoutes } from "../src/routes/kyc";
import { DrizzleKycRepository, DrizzlePrefillConsentRepository } from "../src/repos/index";
import { eraseSellerIdentityLocal } from "../src/services/kyc-retention";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer } from "./setup";
import type { Container } from "../src/services/container";

/**
 * Issue 3.17: /seller/kyc/prefill-consent decides which stored SEP-9 values an
 * anchor's SEP-24 form may open pre-filled with. Names only; off by default.
 */
const ANCHOR = "testanchor.stellar.org";

async function harness(scopes: ApiKeyScope[] = ["offramp:initiate"]) {
  const container = await createTestContainer();
  const prefillConsents = new DrizzlePrefillConsentRepository(container.db);
  const kycRepo = new DrizzleKycRepository(container.db, randomBytes(32));
  const record: KycRecord = {
    sellerId: container.seller.id,
    anchorDomain: ANCHOR,
    account: container.seller.wallet,
    customerId: "cus_1",
    status: "ACCEPTED",
    requiredFields: [],
    // id_number is on file but must never be offered; mobile_number is blank.
    providedFields: { first_name: "Ada", last_name: "Lovelace", id_number: "A1234567", mobile_number: " ", favourite_colour: "green" },
    providedFieldStatus: [],
    sentFields: [],
    message: null,
    lastSyncedAt: 1,
    updatedAt: 1,
  };
  await kycRepo.save(record);

  const c = { ...container, anchorDomain: ANCHOR, prefillConsents, kycRepo, kyc: { resolveType: async () => null } } as unknown as Container;
  const app = kycRoutes(c);

  const { plaintext, prefix } = generateApiKey("test");
  await container.apiKeys.create({
    sellerId: container.seller.id,
    name: "key",
    prefix,
    hash: await hashApiKey(plaintext),
    scopes,
  });
  const session = await container.tokenFor(container.seller.id, container.seller.wallet);
  return { app, container, prefillConsents, key: plaintext, session };
}

const json = (token: string, body: unknown) => ({
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("/seller/kyc/prefill-consent — authentication", () => {
  it("refuses unauthenticated callers", async () => {
    const { app, container, prefillConsents } = await harness();
    expect((await app.request("/prefill-consent")).status).toBe(401);
    const put = await app.request("/prefill-consent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: ["first_name"] }),
    });
    expect(put.status).toBe(401);
    expect(await prefillConsents.list(container.seller.id)).toEqual([]);
    container.client.close();
  });

  it("refuses an API key without offramp:initiate", async () => {
    const { app, container, key } = await harness(["links:read", "links:write"]);
    const get = await app.request("/prefill-consent", { headers: { authorization: `Bearer ${key}` } });
    expect(get.status).toBe(403);
    expect(await get.json()).toEqual({ error: "missing_scope", required: "offramp:initiate" });
    const put = await app.request("/prefill-consent", json(key, { fields: ["first_name"] }));
    expect(put.status).toBe(403);
    container.client.close();
  });

  it("refuses an API key even with the scope: consent is the seller's own to give", async () => {
    const { app, container, key, prefillConsents } = await harness();
    const put = await app.request("/prefill-consent", json(key, { fields: ["first_name"] }));
    expect(put.status).toBe(403);
    expect(await put.json()).toMatchObject({ error: "forbidden" });
    expect((await app.request("/prefill-consent", { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    expect(await prefillConsents.list(container.seller.id)).toEqual([]);
    container.client.close();
  });
});

describe("/seller/kyc/prefill-consent — behaviour", () => {
  it("starts off: nothing consented, and only on-file allowlisted names offered (never id_number, blanks or unlisted)", async () => {
    const { app, container, session } = await harness();
    const res = await app.request("/prefill-consent", { headers: { authorization: `Bearer ${session}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: string[]; fields: string[]; grantedAt: number | null; anchorDomain: string };
    expect(body).toMatchObject({ anchorDomain: ANCHOR, fields: [], grantedAt: null });
    expect(body.available).toEqual(["first_name", "last_name"]);
    // Names only: no value leaves in this response.
    expect(JSON.stringify(body)).not.toContain("Ada");
    expect(JSON.stringify(body)).not.toContain("A1234567");
    container.client.close();
  });

  it("stores exactly the consented names and reads them back", async () => {
    const { app, container, session, prefillConsents } = await harness();
    const put = await app.request("/prefill-consent", json(session, { fields: ["last_name", "first_name", "first_name"] }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ anchorDomain: ANCHOR, fields: ["first_name", "last_name"] });

    expect(await prefillConsents.get(container.seller.id, ANCHOR)).toMatchObject({ fields: ["first_name", "last_name"] });
    const get = (await (await app.request("/prefill-consent", { headers: { authorization: `Bearer ${session}` } })).json()) as {
      fields: string[];
      grantedAt: number;
    };
    expect(get.fields).toEqual(["first_name", "last_name"]);
    expect(get.grantedAt).toBeGreaterThan(0);
    container.client.close();
  });

  it("an empty list withdraws consent", async () => {
    const { app, container, session, prefillConsents } = await harness();
    await app.request("/prefill-consent", json(session, { fields: ["first_name"] }));
    const res = await app.request("/prefill-consent", json(session, { fields: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fields: [], grantedAt: null });
    expect(await prefillConsents.get(container.seller.id, ANCHOR)).toBeNull();
    container.client.close();
  });

  it.each([["id_number"], ["photo_id_front"], ["dest"], ["favourite_colour"]])("rejects %s, which may never be shared", async (name) => {
    const { app, container, session, prefillConsents } = await harness();
    const res = await app.request("/prefill-consent", json(session, { fields: ["first_name", name] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_fields", fields: [name] });
    expect(await prefillConsents.list(container.seller.id)).toEqual([]);
    container.client.close();
  });

  it("rejects a malformed body", async () => {
    const { app, container, session } = await harness();
    expect((await app.request("/prefill-consent", json(session, { fields: "first_name" }))).status).toBe(400);
    expect((await app.request("/prefill-consent", json(session, {}))).status).toBe(400);
    container.client.close();
  });

  it("is erased with the rest of the seller's identity data", async () => {
    const { app, container, session, prefillConsents } = await harness();
    await app.request("/prefill-consent", json(session, { fields: ["first_name"] }));
    await eraseSellerIdentityLocal(container.db, container.seller.id);
    expect(await prefillConsents.list(container.seller.id)).toEqual([]);
    container.client.close();
  });
});
