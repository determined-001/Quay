import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Logger } from "@checkout/core";
import { profileRoutes } from "../src/routes/profile";
import { privacyExportRateLimit, privacyRoutes, PRIVACY_EXPORT_LIMIT } from "../src/routes/privacy";
import { MemoryStore } from "../src/middleware/rate-limit";
import { requestContext } from "../src/request-context";
import {
  DrizzleAnchorSessionRepository,
  DrizzleKycConsentRepository,
  DrizzleKycRepository,
  DrizzleSellerProfileRepository,
  DrizzleSellerRepository,
} from "../src/repos/index";
import { generateApiKey, hashApiKey } from "../src/services/api-keys";
import type { Container } from "../src/services/container";
import { kycDisclosureFields, offrampJobs } from "../src/db/schema";
import { createTestContainer } from "./setup";

const WALLET_B = "GACXZYIBHOK5EGU6CTXOT7EQ24JANLH5C6QNWFGV5BUWLDTOZCP3BTNM";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

// Built at runtime so secret scanners have nothing to flag.
const bearer = (tag: string) => ["anchor", "bearer", tag].join(".");

/** Everything one seller holds, tagged so a leak into another seller's export is unmistakable. */
async function seedSeller(
  container: Awaited<ReturnType<typeof createTestContainer>>,
  deps: {
    key: Buffer;
    sellers: DrizzleSellerRepository;
    profile: DrizzleSellerProfileRepository;
    kyc: DrizzleKycRepository;
    consents: DrizzleKycConsentRepository;
  },
  seller: { id: string; wallet: string },
  tag: string,
) {
  await container.links.create({
    id: `lnk_${tag}`,
    reference: `ref_${tag}`,
    sellerId: seller.id,
    destination: seller.wallet,
    muxedId: null,
    title: `Invoice ${tag}`,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    expiresAt: null,
  });
  await container.links.recordPayment({
    linkId: `lnk_${tag}`,
    txHash: `tx_${tag}`,
    operationId: `op_${tag}`,
    payer: `GPAYER${tag.toUpperCase()}`,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    ledger: 77,
    createdAt: 1_700_000_000_000,
  });
  await container.webhooks.create({
    sellerId: seller.id,
    url: `https://hooks.example/${tag}`,
    secret: `whsec-${tag}-secret-value`,
  });
  const apiKey = generateApiKey("test");
  const keyHash = await hashApiKey(apiKey.plaintext);
  await container.apiKeys.create({
    sellerId: seller.id,
    name: `key ${tag}`,
    prefix: apiKey.prefix,
    hash: keyHash,
    scopes: ["links:read"],
  });
  await deps.profile.upsert(seller.id, { given_name: `Ada-${tag}`, birth_date: "1815-12-10" }, "seller");
  await deps.kyc.save({
    sellerId: seller.id,
    anchorDomain: "testanchor.stellar.org",
    account: seller.wallet,
    customerId: `cust_${tag}`,
    status: "ACCEPTED",
    requiredFields: [],
    providedFields: { first_name: `First-${tag}`, bank_account_number: `acct-${tag}` },
    providedFieldStatus: [{ name: "first_name", status: "ACCEPTED", error: null }],
    sentFields: ["first_name"],
    callbackTokenHash: `cbhash-${tag}`,
    message: `message ${tag}`,
    lastSyncedAt: 1_700_000_000_500,
    updatedAt: 1_700_000_000_600,
  });
  await deps.consents.grant({
    sellerId: seller.id,
    anchorDomain: "testanchor.stellar.org",
    fields: ["first_name"],
    grantedAt: 1_700_000_000_700,
    revokedAt: null,
    grantedVia: "session",
    noticeVersion: `notice-${tag}`,
  });
  await new DrizzleAnchorSessionRepository(container.db).save({
    sellerId: seller.id,
    anchorDomain: "testanchor.stellar.org",
    account: seller.wallet,
    token: bearer(tag),
    expiresAt: 1_900_000_000_000,
    createdAt: 1_700_000_000_000,
  });
  await container.db.insert(kycDisclosureFields).values({
    sellerId: seller.id,
    anchorDomain: "testanchor.stellar.org",
    fieldName: "first_name",
    sentAt: 1_700_000_000_800,
  });
  await container.db.insert(offrampJobs).values({
    jobId: `job_${tag}`,
    linkId: `lnk_${tag}`,
    anchor: "testanchor.stellar.org",
    sellerId: seller.id,
    account: seller.wallet,
    targetCurrency: "NGN",
    targetAmount: "1000",
    rate: "1500",
    status: "completed",
    transferJson: JSON.stringify({ memo: `memo-${tag}` }),
    lastError: `err-${tag}`,
    sellerTxHash: `sellertx_${tag}`,
    createdAt: 1_700_000_000_900,
    updatedAt: 1_700_000_001_000,
  });
  await deps.sellers.savePayoutFields(seller.id, { bank_account_number: `payout-${tag}` });
  return { apiKeyPlaintext: apiKey.plaintext, apiKeyHash: keyHash };
}

async function harness(
  options: { stores?: boolean; logger?: Logger; limiter?: ReturnType<typeof privacyExportRateLimit> } = {},
) {
  const withStores = options.stores !== false;
  const container = await createTestContainer();
  const key = randomBytes(32);

  const sellers = new DrizzleSellerRepository(container.db, key);
  const profile = new DrizzleSellerProfileRepository(container.db, key);
  const kyc = new DrizzleKycRepository(container.db, key);
  const consents = new DrizzleKycConsentRepository(container.db);

  const full = {
    ...container,
    sellers,
    kycConsents: consents,
    sellerProfile: withStores ? profile : null,
    kycRepo: withStores ? kyc : null,
  } as unknown as Container;

  const limiter = options.limiter ?? privacyExportRateLimit(new MemoryStore());
  const app = new Hono();
  if (options.logger) app.use("*", requestContext(options.logger));
  // Same order as index.ts: the export router first, then the profile router.
  app.route("/seller/profile/export", privacyRoutes(full, limiter));
  app.route("/seller/profile", profileRoutes(full));

  const sellerA = await sellers.findById(container.seller.id);
  const sellerB = await sellers.createIfAbsent(WALLET_B);
  if (!sellerA) throw new Error("test seller missing");

  const tokenA = await container.tokenFor(sellerA.id, sellerA.wallet);
  const tokenB = await container.tokenFor(sellerB.id, sellerB.wallet);
  const deps = { key, sellers, profile, kyc, consents };

  return {
    app,
    container,
    deps,
    sellerA,
    sellerB,
    headersA: { authorization: `Bearer ${tokenA}` },
    headersB: { authorization: `Bearer ${tokenB}` },
    seedA: () => seedSeller(container, deps, sellerA, "alpha"),
    seedB: () => seedSeller(container, deps, sellerB, "bravo"),
  };
}

describe("GET /seller/profile/export (issue 4.27)", () => {
  it("returns every personal-data section for the calling seller", async () => {
    const h = await harness();
    await h.seedA();

    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;

    expect(Object.keys(body).sort()).toEqual(
      [
        "anchorConnections",
        "apiKeys",
        "consents",
        "disclosures",
        "generatedAt",
        "kyc",
        "links",
        "offrampJobs",
        "payments",
        "payoutFields",
        "profile",
        "seller",
        "webhooks",
      ].sort(),
    );
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.seller).toEqual({
      id: h.sellerA.id,
      name: h.sellerA.name,
      wallet: h.sellerA.wallet,
      createdAt: new Date(h.sellerA.createdAt).toISOString(),
    });
    expect(body.profile).toEqual([
      { field: "birth_date", value: "1815-12-10", source: "seller", updatedAt: expect.any(String) },
      { field: "given_name", value: "Ada-alpha", source: "seller", updatedAt: expect.any(String) },
    ]);
    expect(body.consents).toEqual([
      {
        anchorDomain: "testanchor.stellar.org",
        fields: ["first_name"],
        grantedAt: new Date(1_700_000_000_700).toISOString(),
        revokedAt: null,
        noticeVersion: "notice-alpha",
      },
    ]);
    expect(body.anchorConnections).toEqual([
      {
        anchorDomain: "testanchor.stellar.org",
        account: h.sellerA.wallet,
        expiresAt: new Date(1_900_000_000_000).toISOString(),
      },
    ]);
    expect(body.payoutFields).toEqual({ bank_account_number: "payout-alpha" });
    expect(body.links).toEqual([
      {
        id: "lnk_alpha",
        reference: "ref_alpha",
        title: "Invoice alpha",
        amount: "10",
        asset: "USDC",
        assetIssuer: ISSUER,
        status: "active",
        createdAt: expect.any(String),
      },
    ]);
    expect(body.payments).toEqual([
      {
        linkId: "lnk_alpha",
        txHash: "tx_alpha",
        payer: "GPAYERALPHA",
        amount: "10",
        asset: "USDC",
        ledger: 77,
        createdAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
    expect(body.webhooks).toEqual([
      { id: expect.any(String), url: "https://hooks.example/alpha", createdAt: expect.any(String) },
    ]);
    expect(body.apiKeys).toEqual([
      {
        id: expect.any(String),
        name: "key alpha",
        scopes: ["links:read"],
        createdAt: expect.any(String),
        lastUsedAt: null,
      },
    ]);
    h.container.client.close();
  });

  it("contains the decrypted KYC values, not the stored ciphertext", async () => {
    const h = await harness();
    await h.seedA();

    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    const body = (await res.json()) as { kyc: Record<string, unknown>[] };

    expect(body.kyc).toEqual([
      {
        anchorDomain: "testanchor.stellar.org",
        account: h.sellerA.wallet,
        customerId: "cust_alpha",
        status: "ACCEPTED",
        message: "message alpha",
        providedFields: { first_name: "First-alpha", bank_account_number: "acct-alpha" },
        providedFieldStatus: [{ name: "first_name", status: "ACCEPTED", error: null }],
        sentFields: ["first_name"],
        lastSyncedAt: new Date(1_700_000_000_500).toISOString(),
      },
    ]);
    h.container.client.close();
  });

  it("includes disclosure history and off-ramp jobs, without anchor instructions or error text", async () => {
    const h = await harness();
    await h.seedA();
    await h.seedB();

    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, any>;

    expect(body.disclosures).toEqual([
      { anchorDomain: "testanchor.stellar.org", fieldName: "first_name", sentAt: new Date(1_700_000_000_800).toISOString() },
    ]);
    expect(body.offrampJobs).toHaveLength(1);
    expect(body.offrampJobs[0]).toMatchObject({ jobId: "job_alpha", sellerTxHash: "sellertx_alpha", status: "completed" });
    expect(text).not.toContain("memo-alpha");
    expect(text).not.toContain("err-alpha");
    expect(text).not.toContain("job_bravo");
    expect(body.truncated).toBeUndefined();
    h.container.client.close();
  });

  it("includes none of another seller's rows", async () => {
    const h = await harness();
    await h.seedA();
    await h.seedB();

    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    const text = await res.text();

    expect(text).toContain("alpha");
    // Every value seeded for seller B carries "bravo"; none may appear in A's export.
    expect(text).not.toContain("bravo");
    expect(text).not.toContain(h.sellerB.id);
    expect(text).not.toContain(h.sellerB.wallet);

    const bRes = await h.app.request("/seller/profile/export", { headers: h.headersB });
    const bText = await bRes.text();
    expect(bText).toContain("bravo");
    expect(bText).not.toContain("alpha");
    h.container.client.close();
  });

  it("contains no credential material: no anchor token, webhook secret, API key or hashes", async () => {
    const h = await harness();
    const { apiKeyPlaintext, apiKeyHash } = await h.seedA();

    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    const text = await res.text();

    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toContain(bearer("alpha"));
    expect(text).not.toContain("whsec-alpha");
    expect(text).not.toContain(apiKeyPlaintext);
    expect(text).not.toContain(apiKeyHash);
    expect(text).not.toContain("cbhash-alpha"); // the KYC callback token hash
    expect(text).not.toMatch(/"(hash|prefix|callbackTokenHash)"/);
    h.container.client.close();
  });

  it("refuses an API key with 403 and reads nothing", async () => {
    const h = await harness();
    const { apiKeyPlaintext } = await h.seedA();

    const res = await h.app.request("/seller/profile/export", {
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("alpha");
    expect(JSON.parse(text)).toMatchObject({ error: "forbidden" });
    h.container.client.close();
  });

  it("requires authentication", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/profile/export");
    expect(res.status).toBe(401);
    h.container.client.close();
  });

  it("is sent as a no-store attachment named for the seller and the date", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });

    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const day = new Date().toISOString().slice(0, 10);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="quay-export-${h.sellerA.id}-${day}.json"`,
    );
    h.container.client.close();
  });

  it("is rate-limited per seller: the sixth request in the window is a 429", async () => {
    const h = await harness();
    const hit = (headers: Record<string, string>) =>
      h.app.request("/seller/profile/export", { headers });

    for (let i = 0; i < PRIVACY_EXPORT_LIMIT.max; i++) {
      expect((await hit(h.headersA)).status).toBe(200);
    }
    const limited = await hit(h.headersA);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    // Another seller has their own budget.
    expect((await hit(h.headersB)).status).toBe(200);
    h.container.client.close();
  });

  it("does not spend the budget on a request that fails authentication", async () => {
    const h = await harness();
    for (let i = 0; i < PRIVACY_EXPORT_LIMIT.max + 2; i++) {
      expect((await h.app.request("/seller/profile/export")).status).toBe(401);
    }
    expect((await h.app.request("/seller/profile/export", { headers: h.headersA })).status).toBe(200);
    h.container.client.close();
  });

  it("logs privacy.export with the sellerId and nothing from the export", async () => {
    const lines: Record<string, unknown>[] = [];
    const make = (): Logger => {
      const log = (obj: unknown) => {
        if (typeof obj === "object" && obj !== null) lines.push(obj as Record<string, unknown>);
      };
      return { debug: log, info: log, warn: log, error: log, child: () => make() } as unknown as Logger;
    };
    const h = await harness({ logger: make() });
    await h.seedA();

    await h.app.request("/seller/profile/export", { headers: h.headersA });

    const entry = lines.find((l) => l.event === "privacy.export");
    expect(entry).toMatchObject({ event: "privacy.export", sellerId: h.sellerA.id });
    expect(JSON.stringify(lines)).not.toContain("alpha");
    h.container.client.close();
  });

  it("omits the profile and kyc sections when this deployment has no encrypted store", async () => {
    const h = await harness({ stores: false });
    await h.seedA();

    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("profile");
    expect(body).not.toHaveProperty("kyc");
    // The sections that do not need the store are still there.
    expect(body.links).toHaveLength(1);
    expect(body.consents).toHaveLength(1);
    h.container.client.close();
  });

  it("reports empty arrays and null payout fields for a seller who holds nothing", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/profile/export", { headers: h.headersB });
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      profile: [],
      kyc: [],
      consents: [],
      anchorConnections: [],
      payoutFields: null,
      links: [],
      payments: [],
      webhooks: [],
      apiKeys: [],
    });
    h.container.client.close();
  });

  it("is answered by the export router, not swallowed by the profile router mounted after it", async () => {
    const h = await harness();
    // The profile router would answer GET / with {fields: [...]}; /export must not.
    const res = await h.app.request("/seller/profile/export", { headers: h.headersA });
    expect(await res.json()).not.toHaveProperty("fields");

    const profileRes = await h.app.request("/seller/profile", { headers: h.headersA });
    expect(await profileRes.json()).toHaveProperty("fields");
    h.container.client.close();
  });
});
