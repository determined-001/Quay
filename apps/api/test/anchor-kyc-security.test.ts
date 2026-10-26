import { describe, expect, it } from "vitest";
import type { MiddlewareHandler } from "hono";
import { AnchorChallengeError, type SellerAnchorAuth } from "@checkout/offramp";
import type { AnchorCustomer, KycRecord } from "@checkout/core";
import { anchorAuthRoutes } from "../src/routes/anchor-auth";
import { kycRoutes, KYC_MAX_FIELDS, KYC_MAX_VALUE_LENGTH } from "../src/routes/kyc";
import { MemoryStore, rateLimit } from "../src/middleware/rate-limit";
import { generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { createTestContainer, type TestContainer } from "./setup";
import type { Container } from "../src/services/container";

/**
 * The checklist in docs/security/anchor-kyc-routes.md, one test per line
 * (issue 8.17). The routes themselves are covered for authentication and scope
 * in kyc-route-auth.test.ts and anchor-auth-route.test.ts.
 */
const ALLOWED_ORIGIN = "https://app.example";
const EVIL = "https://evil.example";

const record: KycRecord = {
  sellerId: "sel_x",
  anchorDomain: "anchor.example",
  account: null,
  customerId: "cus_1",
  status: "ACCEPTED",
  requiredFields: [],
  providedFields: { first_name: "Ada", bank_account_number: "1234567890" },
  providedFieldStatus: [],
  sentFields: [],
  message: null,
  lastSyncedAt: 1,
  updatedAt: 1,
};

async function build(opts: { limiter?: MiddlewareHandler; anchorAuth?: Partial<SellerAnchorAuth> | null } = {}) {
  const container = await createTestContainer();
  const submitted: Record<string, string>[] = [];
  const signedOut: string[] = [];
  const completed: Array<{ customer: AnchorCustomer; tx: string }> = [];
  container.auth.allowedOrigins = [ALLOWED_ORIGIN];

  const kyc = {
    async status() {
      return record;
    },
    async submit(_customer: AnchorCustomer, fields: Record<string, string>) {
      submitted.push(fields);
      return record;
    },
  };
  const anchorAuth = {
    anchorDomain: "anchor.example",
    sessionExpiry: async () => 1_900_000_000_000,
    challenge: async () => ({ transaction: "AAAA", networkPassphrase: "Test SDF Network ; September 2015" }),
    complete: async (customer: AnchorCustomer, tx: string) => {
      completed.push({ customer, tx });
      return { expiresAt: 1_900_000_000_000 };
    },
    signOut: async (sellerId: string) => {
      signedOut.push(sellerId);
    },
    ...opts.anchorAuth,
  } as unknown as SellerAnchorAuth;

  const wired = {
    ...container,
    kyc,
    anchorDomain: "anchor.example",
    anchorAuth,
    kycConsents: {
      list: async () => [],
      active: async (sellerId: string, anchorDomain: string) => ({
        id: "cnc_1",
        sellerId,
        anchorDomain,
        fields: ["first_name", "bank_account_number"],
        grantedAt: 1,
        revokedAt: null,
        grantedVia: "session",
        noticeVersion: "1.0",
      }),
    },
  } as unknown as Container;

  const passThrough: MiddlewareHandler = async (_c, next) => next();
  const kycApp = kycRoutes(wired, opts.limiter ?? passThrough);
  const authApp = anchorAuthRoutes(wired, passThrough);

  const bearer = await container.tokenFor(container.seller.id, container.seller.wallet);
  const { plaintext, prefix } = generateApiKey("test");
  await container.apiKeys.create({
    sellerId: container.seller.id,
    name: "kyc security key",
    prefix,
    hash: await hashApiKey(plaintext),
    scopes: ["offramp:initiate"] as ApiKeyScope[],
  });
  return {
    container: container as TestContainer,
    kycApp,
    authApp,
    bearer,
    apiKey: plaintext,
    submitted,
    signedOut,
    completed,
  };
}

const json = { "content-type": "application/json" };

describe("CSRF: cookie-authenticated state changes need an allowed Origin", () => {
  const stateChanges = (h: Awaited<ReturnType<typeof build>>) =>
    [
      ["PUT /seller/kyc", () => h.kycApp, "/", "PUT", JSON.stringify({ first_name: "Mallory" })],
      ["POST /seller/anchor-auth/challenge", () => h.authApp, "/challenge", "POST", undefined],
      ["POST /seller/anchor-auth", () => h.authApp, "/", "POST", JSON.stringify({ transaction: "AAAA" })],
      ["DELETE /seller/anchor-auth", () => h.authApp, "/", "DELETE", undefined],
    ] as const;

  it.each([
    ["a foreign Origin", { origin: EVIL }],
    ["no Origin", {}],
  ])("refuses every state change carried by the session cookie with %s", async (_name, originHeader) => {
    const h = await build();
    for (const [label, app, path, method, body] of stateChanges(h)) {
      const res = await app().request(path, {
        method,
        headers: { ...json, cookie: `session=${h.bearer}`, ...originHeader },
        body,
      });
      expect(res.status, label).toBe(403);
    }
    expect(h.submitted).toEqual([]);
    expect(h.completed).toEqual([]);
    expect(h.signedOut).toEqual([]);
    h.container.client.close();
  });

  it("accepts the same requests from an allowed Origin", async () => {
    const h = await build();
    for (const [label, app, path, method, body] of stateChanges(h)) {
      const res = await app().request(path, {
        method,
        headers: { ...json, cookie: `session=${h.bearer}`, origin: ALLOWED_ORIGIN },
        body,
      });
      expect(res.status, label).toBeLessThan(300);
    }
    h.container.client.close();
  });

  it("does not apply the Origin rule to a bearer token, which carries its own intent", async () => {
    const h = await build();
    const res = await h.kycApp.request("/", {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${h.bearer}`, origin: EVIL },
      body: JSON.stringify({ first_name: "Ada" }),
    });
    expect(res.status).toBe(200);
    h.container.client.close();
  });
});

describe("PUT /seller/kyc input bounds", () => {
  const put = (h: Awaited<ReturnType<typeof build>>, body: unknown) =>
    h.kycApp.request("/", {
      method: "PUT",
      headers: { ...json, authorization: `Bearer ${h.bearer}` },
      body: JSON.stringify(body),
    });

  it("accepts a normal SEP-9 map and forwards it", async () => {
    const h = await build();
    const res = await put(h, { first_name: "Ada", "photo_id.front": "x", email_address: "a@b.example" });
    expect(res.status).toBe(200);
    expect(h.submitted).toHaveLength(1);
    h.container.client.close();
  });

  it(`refuses more than ${KYC_MAX_FIELDS} fields with the invalid_body shape`, async () => {
    const h = await build();
    const tooMany = Object.fromEntries(Array.from({ length: KYC_MAX_FIELDS + 1 }, (_, i) => [`field_${i}`, "x"]));
    const res = await put(h, tooMany);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(h.submitted).toEqual([]);
    h.container.client.close();
  });

  it("accepts exactly the maximum number of fields", async () => {
    const h = await build();
    const max = Object.fromEntries(Array.from({ length: KYC_MAX_FIELDS }, (_, i) => [`field_${i}`, "x"]));
    expect((await put(h, max)).status).toBe(200);
    h.container.client.close();
  });

  it.each(["First_Name", "has space", "a".repeat(65), "", "semi;colon", "../etc"])(
    "refuses the field name %j",
    async (name) => {
      const h = await build();
      const res = await put(h, { [name]: "x" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_body" });
      expect(h.submitted).toEqual([]);
      h.container.client.close();
    },
  );

  it(`refuses a value longer than ${KYC_MAX_VALUE_LENGTH} characters, and accepts one at the limit`, async () => {
    const h = await build();
    const over = await put(h, { first_name: "x".repeat(KYC_MAX_VALUE_LENGTH + 1) });
    expect(over.status).toBe(400);
    expect(h.submitted).toEqual([]);

    const atLimit = await put(h, { first_name: "x".repeat(KYC_MAX_VALUE_LENGTH) });
    expect(atLimit.status).toBe(200);
    h.container.client.close();
  });

  it("refuses non-string values", async () => {
    const h = await build();
    expect((await put(h, { first_name: 5 })).status).toBe(400);
    expect((await put(h, { first_name: { nested: "x" } })).status).toBe(400);
    expect((await put(h, ["first_name"])).status).toBe(400);
    h.container.client.close();
  });
});

describe("PII exposure to API keys", () => {
  it("shows providedFields to a signed-in session", async () => {
    const h = await build();
    const res = await h.kycApp.request("/", { headers: { authorization: `Bearer ${h.bearer}` } });
    expect(((await res.json()) as KycRecord).providedFields).toEqual(record.providedFields);
    h.container.client.close();
  });

  it("withholds providedFields from an API key on both read and write, while keeping status", async () => {
    const h = await build();
    const headers = { ...json, authorization: `Bearer ${h.apiKey}` };

    const read = await h.kycApp.request("/", { headers });
    const readText = await read.text();
    expect(JSON.parse(readText)).toMatchObject({ status: "ACCEPTED", providedFields: {} });
    expect(readText).not.toContain("Ada");
    expect(readText).not.toContain("1234567890");

    const write = await h.kycApp.request("/", { method: "PUT", headers, body: JSON.stringify({ first_name: "Ada" }) });
    const writeText = await write.text();
    expect(write.status).toBe(200);
    expect(JSON.parse(writeText)).toMatchObject({ providedFields: {} });
    expect(writeText).not.toContain("1234567890");
    h.container.client.close();
  });
});

describe("responses are not cacheable", () => {
  it("sends Cache-Control: no-store on GET /seller/kyc and GET /seller/anchor-auth", async () => {
    const h = await build();
    const headers = { authorization: `Bearer ${h.bearer}` };
    expect((await h.kycApp.request("/", { headers })).headers.get("cache-control")).toBe("no-store");
    expect((await h.authApp.request("/", { headers })).headers.get("cache-control")).toBe("no-store");
    h.container.client.close();
  });

  it("also sends it on an error, so a 403 or 401 body is not cached either", async () => {
    const h = await build();
    const res = await h.kycApp.request("/");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    h.container.client.close();
  });
});

describe("rate limits", () => {
  it("applies the strict limiter to PUT /seller/kyc per seller", async () => {
    const limiter = rateLimit({
      windowMs: 60_000,
      max: 1,
      store: new MemoryStore(),
      keyFor: (ctx) => `kyc-write:${(ctx.get("seller") as { id: string }).id}`,
    });
    const h = await build({ limiter });
    const send = () =>
      h.kycApp.request("/", {
        method: "PUT",
        headers: { ...json, authorization: `Bearer ${h.bearer}` },
        body: JSON.stringify({ first_name: "Ada" }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    // Reads are not on that budget.
    expect((await h.kycApp.request("/", { headers: { authorization: `Bearer ${h.bearer}` } })).status).toBe(200);
    h.container.client.close();
  });
});

describe("anchor-auth error bodies", () => {
  it("returns fixed text for a challenge the anchor refused, never the anchor's wording", async () => {
    const h = await build({
      anchorAuth: {
        challenge: async () => {
          throw new AnchorChallengeError("SECRET-ANCHOR-TEXT <script>alert(1)</script>", "refused");
        },
      },
    });
    const res = await h.authApp.request("/challenge", {
      method: "POST",
      headers: { authorization: `Bearer ${h.bearer}` },
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: "challenge_rejected",
      message: "The anchor refused the signed challenge.",
    });
    expect(text).not.toContain("SECRET-ANCHOR-TEXT");
    expect(text).not.toContain("<script>");
    h.container.client.close();
  });
});

describe("cross-seller", () => {
  it("answers 400 challenge_rejected when the signed challenge belongs to another account", async () => {
    const h = await build({
      anchorAuth: {
        complete: async () => {
          throw new AnchorChallengeError("challenge is for a different account than the signed-in seller", "wrong_account");
        },
      },
    });
    const res = await h.authApp.request("/", {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${h.bearer}` },
      body: JSON.stringify({ transaction: "AAAA-for-seller-A" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "challenge_rejected",
      message: "The challenge or token belongs to a different account than your signed-in wallet.",
    });
    h.container.client.close();
  });

  it("only ever completes a session for the caller's own account", async () => {
    const h = await build();
    await h.authApp.request("/", {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${h.bearer}` },
      body: JSON.stringify({ transaction: "AAAA" }),
    });
    expect(h.completed).toEqual([
      { customer: { sellerId: h.container.seller.id, account: h.container.seller.wallet }, tx: "AAAA" },
    ]);
    h.container.client.close();
  });
});
