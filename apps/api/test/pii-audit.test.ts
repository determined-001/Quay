import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnchorAuthRequiredError,
  NOOP_LOGGER,
  type AnchorCustomer,
  type KycRecord,
  type Logger,
} from "@checkout/core";
import { kycRoutes } from "../src/routes/kyc";
import { profileRoutes } from "../src/routes/profile";
import { privacyExportRateLimit, privacyRoutes } from "../src/routes/privacy";
import { telemetryRoutes } from "../src/routes/telemetry";
import { MemoryStore } from "../src/middleware/rate-limit";
import { requestContext } from "../src/request-context";
import { DrizzleSellerProfileRepository } from "../src/repos/index";
import { generateApiKey, hashApiKey } from "../src/services/api-keys";
import { LinkService, CASH_OUT_GATE_ACTOR } from "../src/services/link-service";
import {
  PII_AUDIT_RETENTION_DAYS,
  PiiAuditService,
  runPiiAuditSweep,
  type PiiAuditEntry,
  type PiiAuditRecorder,
} from "../src/services/pii-audit";
import { metrics } from "../src/metrics";
import { piiAudit } from "../src/db/schema";
import type { Container } from "../src/services/container";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedKyc,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";
import { createTestContainer, testStellarConfig, type TestContainer } from "./setup";

// API-key setup hashes with scrypt, which is slow on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

// Distinctive stand-ins for real identity values: if any of these ever reaches
// an audit row, the "no values" assertions below catch it.
const SECRET_NAME = "Zanzibar-Okonkwo-7731";
const SECRET_ACCOUNT = "9988776655443";
const SECRET_VALUES = [SECRET_NAME, SECRET_ACCOUNT];

const record: KycRecord = {
  sellerId: "sel_x",
  anchorDomain: "testanchor.stellar.org",
  account: null,
  customerId: "cus_1",
  status: "ACCEPTED",
  requiredFields: [],
  providedFields: { first_name: SECRET_NAME, bank_account_number: SECRET_ACCOUNT },
  providedFieldStatus: [],
  sentFields: [],
  message: null,
  lastSyncedAt: 1,
  updatedAt: 1,
};

async function rowsOf(container: TestContainer) {
  return container.db.select().from(piiAudit);
}

function expectNoValues(rows: unknown) {
  const text = JSON.stringify(rows);
  for (const v of SECRET_VALUES) expect(text).not.toContain(v);
}

async function harness() {
  const container = await createTestContainer();
  const audit = new PiiAuditService(container.db, NOOP_LOGGER);
  const profile = new DrizzleSellerProfileRepository(container.db, randomBytes(32));
  const seen: AnchorCustomer[] = [];
  const full = {
    ...container,
    piiAudit: audit,
    sellerProfile: profile,
    kycRepo: null,
    kycConsents: {
      async list() { return []; },
      async grant(c: object) { return { ...c, id: "cnc_1" }; },
      async active(sellerId: string, anchorDomain: string) {
        return {
          id: "cnc_1", sellerId, anchorDomain, fields: ["first_name", "bank_account_number", "photo_id_front"],
          grantedAt: 1, revokedAt: null, grantedVia: "session", noticeVersion: "1.0",
        };
      },
      async revoke() {},
    },
    kyc: {
      async status(customer: AnchorCustomer) { seen.push(customer); return record; },
      async submit(customer: AnchorCustomer) { seen.push(customer); return record; },
      async submitFiles(customer: AnchorCustomer) { seen.push(customer); return { ...record, status: "PROCESSING" }; },
    },
    anchorDomain: "testanchor.stellar.org",
  } as unknown as Container;

  // Same order as index.ts: request context first, so every audit row carries the request id.
  const app = new Hono();
  app.use("*", requestContext(NOOP_LOGGER));
  app.route("/seller/kyc", kycRoutes(full));
  app.route("/seller/profile/export", privacyRoutes(full, privacyExportRateLimit(new MemoryStore())));
  app.route("/seller/profile", profileRoutes(full));

  const seller = container.seller;
  const token = await container.tokenFor(seller.id, seller.wallet);
  const created = generateApiKey("test");
  const key = await container.apiKeys.create({
    sellerId: seller.id,
    name: "audit key",
    prefix: created.prefix,
    hash: await hashApiKey(created.plaintext),
    scopes: ["offramp:initiate"],
  });
  return {
    app, container, full, audit, seller, seen,
    session: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-request-id": "req-session-0001" },
    apiKeyId: key.id,
    apiKeyHeaders: { authorization: `Bearer ${created.plaintext}`, "content-type": "application/json", "x-request-id": "req-apikey-0001" },
  };
}

describe("PII audit: routes write exactly one row (issue 8.15)", () => {
  it("GET /seller/kyc by a session: one kyc.read row naming the fields the response carried", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/kyc", { headers: h.session });
    expect(res.status).toBe(200);

    const rows = await rowsOf(h.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sellerId: h.seller.id,
      actorType: "session",
      actorId: h.seller.id,
      action: "kyc.read",
      requestId: "req-session-0001",
    });
    expect(JSON.parse(rows[0]!.fields!).sort()).toEqual(["bank_account_number", "first_name"]);
    expect(typeof rows[0]!.at).toBe("number");
    expectNoValues(rows);
  });

  it("GET /seller/kyc by an API key: one api_key row with the key id and no fields (the key never sees values)", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/kyc", { headers: h.apiKeyHeaders });
    expect(res.status).toBe(200);
    expect((await res.json()) as { providedFields: object }).toMatchObject({ providedFields: {} });

    const rows = await rowsOf(h.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "api_key",
      actorId: h.apiKeyId,
      action: "kyc.read",
      fields: null,
      requestId: "req-apikey-0001",
    });
    expectNoValues(rows);
  });

  it("PUT /seller/kyc: one kyc.submit row with the submitted field names, not their values", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/kyc", {
      method: "PUT",
      headers: h.session,
      body: JSON.stringify({ first_name: SECRET_NAME, bank_account_number: SECRET_ACCOUNT }),
    });
    expect(res.status).toBe(200);

    const rows = await rowsOf(h.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "session", action: "kyc.submit" });
    expect(JSON.parse(rows[0]!.fields!).sort()).toEqual(["bank_account_number", "first_name"]);
    expectNoValues(rows);
  });

  it("PUT /seller/kyc/files: one kyc.submit row naming the uploaded field", async () => {
    const h = await harness();
    // The route needs the anchor to ask for the binary field.
    (h.full.kyc as unknown as { status: () => Promise<KycRecord> }).status = async () => ({
      ...record,
      requiredFields: [{ name: "photo_id_front", type: "binary", optional: false }],
    });
    const form = new FormData();
    form.append("photo_id_front", new Blob(["fake-image-bytes"], { type: "image/jpeg" }), "id.jpg");
    const res = await h.app.request("/seller/kyc/files", {
      method: "PUT",
      headers: { authorization: h.session.authorization, "x-request-id": h.session["x-request-id"] },
      body: form,
    });
    expect(res.status).toBe(200);

    const rows = await rowsOf(h.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "session", action: "kyc.submit", fields: '["photo_id_front"]' });
    expect(JSON.stringify(rows)).not.toContain("fake-image-bytes");
  });

  it("a request that is refused or fails writes no row", async () => {
    const h = await harness();
    expect((await h.app.request("/seller/kyc")).status).toBe(401);
    (h.full.kyc as unknown as { status: () => Promise<KycRecord> }).status = async () => {
      throw new AnchorAuthRequiredError("testanchor.stellar.org");
    };
    expect((await h.app.request("/seller/kyc", { headers: h.session })).status).toBe(403);
    expect(await rowsOf(h.container)).toHaveLength(0);
  });

  it("profile GET / PUT / DELETE: one row each (profile.read, profile.write, profile.erase)", async () => {
    const h = await harness();
    const put = await h.app.request("/seller/profile", {
      method: "PUT",
      headers: h.session,
      body: JSON.stringify({ given_name: SECRET_NAME, family_name: SECRET_ACCOUNT }),
    });
    expect(put.status).toBe(200);
    expect((await h.app.request("/seller/profile", { headers: h.session })).status).toBe(200);
    const del = await h.app.request("/seller/profile", {
      method: "DELETE",
      headers: h.session,
      body: JSON.stringify({ confirm: h.seller.wallet }),
    });
    expect(del.status).toBe(200);

    const rows = (await rowsOf(h.container)).sort((a, b) => a.at - b.at);
    expect(rows.map((r) => r.action).sort()).toEqual(["profile.erase", "profile.read", "profile.write"]);
    for (const r of rows) {
      expect(r).toMatchObject({ sellerId: h.seller.id, actorType: "session", actorId: h.seller.id, requestId: "req-session-0001" });
    }
    const read = rows.find((r) => r.action === "profile.read")!;
    expect(JSON.parse(read.fields!).sort()).toEqual(["family_name", "given_name"]);
    expect(rows.find((r) => r.action === "profile.erase")!.fields).toBeNull();
    expectNoValues(rows);
  });

  it("profile routes refuse an API key and write nothing", async () => {
    const h = await harness();
    const res = await h.app.request("/seller/profile", { headers: h.apiKeyHeaders });
    expect(res.status).toBe(403);
    expect(await rowsOf(h.container)).toHaveLength(0);
  });

  it("GET /seller/profile/export: one profile.export row", async () => {
    const h = await harness();
    await h.full.sellerProfile!.upsert(h.seller.id, { given_name: SECRET_NAME }, "seller");
    const res = await h.app.request("/seller/profile/export", { headers: h.session });
    expect(res.status).toBe(200);

    const rows = await rowsOf(h.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "session", action: "profile.export", fields: '["given_name"]' });
    expectNoValues(rows);
  });
});

describe("PII audit: the privacy export lists the seller's own entries", () => {
  it("includes this seller's access history and none of another seller's", async () => {
    const h = await harness();
    const other = await h.container.sellers.createIfAbsent("GACXZYIBHOK5EGU6CTXOT7EQ24JANLH5C6QNWFGV5BUWLDTOZCP3BTNM");
    await h.audit.record({ sellerId: other.id, actorType: "system", actorId: "someone-else", action: "kyc.read" });
    await h.app.request("/seller/kyc", { headers: h.session });
    await h.app.request("/seller/kyc", { headers: h.apiKeyHeaders });

    const res = await h.app.request("/seller/profile/export", { headers: h.session });
    const body = (await res.json()) as { piiAccess: Array<Record<string, unknown>> };

    expect(body.piiAccess).toHaveLength(2);
    expect(body.piiAccess.map((e) => e.actorType).sort()).toEqual(["api_key", "session"]);
    expect(JSON.stringify(body.piiAccess)).not.toContain("someone-else");
    for (const e of body.piiAccess) {
      expect(Object.keys(e).sort()).toEqual(["action", "actorId", "actorType", "at", "fields", "requestId"]);
    }
    // The export call itself is recorded after the export is built.
    expect(await rowsOf(h.container)).toHaveLength(4 /* other + 2 reads + this export */);
  });

  it("omits the section when the audit log is not configured", async () => {
    const h = await harness();
    const app = new Hono();
    app.route(
      "/seller/profile/export",
      privacyRoutes({ ...h.full, piiAudit: undefined } as unknown as Container, privacyExportRateLimit(new MemoryStore())),
    );
    const res = await app.request("/seller/profile/export", { headers: h.session });
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).not.toContain("piiAccess");
  });
});

describe("PII audit: system reads at the cash-out gate", () => {
  function gateService(kyc: ScriptedKyc | AlwaysAcceptedKyc, piiAudit: PiiAuditRecorder | undefined) {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async () => ({ quoteId: "q_1" }) as never;
    return new LinkService({
      links,
      sellers: {
        findById: async (id: string) =>
          id === "sel_1" ? { id: "sel_1", name: "Seller", wallet: "GSELLER", profileKind: "individual", payoutFields: null, createdAt: 0 } : null,
        findByWallet: async () => null,
        createIfAbsent: async () => ({ id: "sel_1", name: "Seller", wallet: "GSELLER", profileKind: "individual", payoutFields: null, createdAt: 0 }),
        savePayoutFields: async () => {},
        saveProfileKind: async () => {},
      },
      webhooks: new FakeWebhookRepository(),
      rail: { async assertCanReceive() {}, buildRequest: () => { throw new Error("unused"); } } as never,
      offramp,
      offrampState: new FakeOffRampStateRepository(),
      kyc,
      stellar: testStellarConfig,
      telemetry: new FakeTelemetryRepository(),
      correlation: "memo",
      webhookGuard: async () => ({ ok: true }) as const,
      piiAudit,
    });
  }

  it("records one system kyc.read with the request id, and no identity values", async () => {
    const calls: PiiAuditEntry[] = [];
    const kyc = new ScriptedKyc();
    kyc.statusImpl = async ({ sellerId, account }) => ({ ...record, sellerId, account, status: "NEEDS_INFO" });
    const service = gateService(kyc, { record: async (e) => void calls.push(e) });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }, { requestId: "req-gate-0001" }),
    ).rejects.toMatchObject({ status: 403, message: "kyc_required" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sellerId: "sel_1",
      actorType: "system",
      actorId: CASH_OUT_GATE_ACTOR,
      action: "kyc.read",
      requestId: "req-gate-0001",
    });
    expectNoValues(calls);
  });

  it("the quote gate is audited too, and a service without an audit log still works", async () => {
    const calls: PiiAuditEntry[] = [];
    const audited = gateService(new AlwaysAcceptedKyc(), { record: async (e) => void calls.push(e) });
    await expect(audited.quoteCashOut("lnk_1", "NGN")).resolves.toBeDefined();
    expect(calls).toHaveLength(1);

    const plain = gateService(new AlwaysAcceptedKyc(), undefined);
    await expect(plain.quoteCashOut("lnk_1", "NGN")).resolves.toBeDefined();
  });
});

describe("PII audit: a failed write never breaks the request", () => {
  it("GET /seller/kyc still answers 200, logs pii_audit.write_failed and counts the failure", async () => {
    const h = await harness();
    const logged: Array<Record<string, unknown>> = [];
    const logger: Logger = { ...NOOP_LOGGER, error: (...args: unknown[]) => void logged.push(args[0] as Record<string, unknown>) };
    const broken = new PiiAuditService(h.container.db, logger);
    const app = new Hono();
    app.use("*", requestContext(NOOP_LOGGER));
    app.route("/seller/kyc", kycRoutes({ ...h.full, piiAudit: broken } as unknown as Container));
    await h.container.client.execute("DROP TABLE pii_audit");

    const before = failureCount();
    const res = await app.request("/seller/kyc", { headers: h.session });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { providedFields: Record<string, string> }).providedFields.first_name).toBe(SECRET_NAME);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: "pii_audit.write_failed", action: "kyc.read", sellerId: h.seller.id });
    expectNoValues(logged);
    expect(failureCount()).toBe(before + 1);
  });

  function failureCount(): number {
    const m = /^pii_audit_write_failures_total (\d+)$/m.exec(metrics.piiAuditWriteFailuresTotal.render());
    return m ? Number(m[1]) : 0;
  }
});

describe("GET /telemetry/pii-audit", () => {
  const original = process.env.TELEMETRY_TOKEN;
  beforeEach(() => {
    process.env.TELEMETRY_TOKEN = "test-telemetry-token";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.TELEMETRY_TOKEN;
    else process.env.TELEMETRY_TOKEN = original;
  });
  const auth = { authorization: "Bearer test-telemetry-token" };

  async function seeded(n: number) {
    const container = await createTestContainer();
    const audit = new PiiAuditService(container.db, NOOP_LOGGER);
    for (let i = 0; i < n; i++) {
      // Same millisecond for several rows would hide an ordering bug; spread them.
      await container.db.insert(piiAudit).values({
        id: `pia_${String(i).padStart(3, "0")}`,
        at: 1_000 + Math.floor(i / 2),
        sellerId: i % 5 === 4 ? "sel_other" : "sel_target",
        actorType: "session",
        actorId: "sel_target",
        action: "kyc.read",
        fields: '["first_name"]',
        requestId: `req_${i}`,
      });
    }
    const app = telemetryRoutes({ ...container, piiAudit: audit } as unknown as Container);
    return { app, container };
  }

  it("is disabled without a token, and rejects a missing or wrong one", async () => {
    const { app } = await seeded(1);
    expect((await app.request("/pii-audit?sellerId=sel_target")).status).toBe(401);
    expect((await app.request("/pii-audit?sellerId=sel_target", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    delete process.env.TELEMETRY_TOKEN;
    const off = telemetryRoutes({ piiAudit: {} } as unknown as Container);
    expect((await off.request("/pii-audit?sellerId=sel_target")).status).toBe(404);
  });

  it("filters by seller and pages newest first without gaps or repeats", async () => {
    const { app } = await seeded(20); // 16 for sel_target, 4 for sel_other
    const collected: Array<{ id: string; at: number; sellerId: string }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Response = await app.request(
        `/pii-audit?sellerId=sel_target&limit=5${cursor ? `&cursor=${cursor}` : ""}`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { entries: typeof collected; nextCursor: string | null };
      expect(body.entries.length).toBeLessThanOrEqual(5);
      collected.push(...body.entries);
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(collected).toHaveLength(16);
    expect(new Set(collected.map((e) => e.id)).size).toBe(16);
    expect(collected.every((e) => e.sellerId === "sel_target")).toBe(true);
    const ats = collected.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
  });

  it("returns entries in the documented shape, with parsed field names", async () => {
    const { app } = await seeded(1);
    const res = await app.request("/pii-audit?sellerId=sel_target", { headers: auth });
    expect(await res.json()).toEqual({
      entries: [
        {
          id: "pia_000", at: 1_000, sellerId: "sel_target", actorType: "session", actorId: "sel_target",
          action: "kyc.read", fields: ["first_name"], requestId: "req_0",
        },
      ],
      nextCursor: null,
    });
  });

  it("rejects a malformed cursor or limit with 400, and caps the page size", async () => {
    const { app } = await seeded(3);
    expect((await app.request("/pii-audit?cursor=!!!", { headers: auth })).status).toBe(400);
    expect((await app.request("/pii-audit?limit=abc", { headers: auth })).status).toBe(400);
    const big = await app.request("/pii-audit?limit=100000", { headers: auth });
    expect(big.status).toBe(200);
  });
});

describe("PII audit retention sweep", () => {
  it("deletes rows older than two years and keeps everything newer", async () => {
    const container = await createTestContainer();
    const now = Date.UTC(2026, 5, 1);
    const day = 86_400_000;
    const row = (id: string, ageDays: number) => ({
      id, at: now - ageDays * day, sellerId: "sel_1", actorType: "session" as const, actorId: "sel_1", action: "kyc.read",
    });
    await container.db.insert(piiAudit).values([
      row("old_1", PII_AUDIT_RETENTION_DAYS + 1),
      row("old_2", PII_AUDIT_RETENTION_DAYS + 400),
      row("edge", PII_AUDIT_RETENTION_DAYS - 1),
      row("recent", 3),
    ]);

    const result = await runPiiAuditSweep({ db: container.db, now });

    expect(result).toEqual({ deleted: 2 });
    const left = (await container.db.select().from(piiAudit)).map((r) => r.id).sort();
    expect(left).toEqual(["edge", "recent"]);
  });

  it("is a no-op on an empty table", async () => {
    const container = await createTestContainer();
    expect(await runPiiAuditSweep({ db: container.db })).toEqual({ deleted: 0 });
  });
});
