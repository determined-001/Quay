import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { CannotReceiveError, type LinkStatus } from "@checkout/core";
import { invoices } from "../src/db/schema";
import { DrizzleInvoiceRepository } from "../src/repos/invoices";
import { invoiceRoutes } from "../src/routes/invoices";
import { DEFAULT_SCOPES, generateApiKey, hashApiKey, type ApiKeyScope } from "../src/services/api-keys";
import { InvoiceService } from "../src/services/invoice-service";
import type { PiiAuditEntry } from "../src/services/pii-audit";
import { decryptSecret } from "../src/services/secret-crypto";
import { createTestContainer, type TestContainer } from "./setup";

// Issue 4.67 (#560): the invoice API.

const DAY = 24 * 60 * 60 * 1000;
const EMAIL = "client@example.test";
const ADDRESS = "12 Marina Road, Lagos";
const NOTES = "Net 14. Thank you.";

let container: TestContainer;
let repo: DrizzleInvoiceRepository;
let app: Hono;
let token = "";
let otherToken = "";
const flag = { invoicesEnabled: true };
const clock = { offset: 0 };
const numbers = { calls: 0 };
const audit: PiiAuditEntry[] = [];
const railCanReceive = { fail: false };

beforeAll(async () => {
  container = await createTestContainer();
  repo = new DrizzleInvoiceRepository(container.db);
  container.rail.assertCanReceive = async () => {
    if (railCanReceive.fail) throw new CannotReceiveError("no_trustline", "The seller has no USDC trustline.");
  };
  (container as { piiAudit?: unknown }).piiAudit = { record: async (entry: PiiAuditEntry) => void audit.push(entry) };
  const service = new InvoiceService({
    invoices: repo,
    links: container.links,
    sellers: container.sellers,
    linkService: container.service,
    numbers: {
      next: async (sellerId) => {
        numbers.calls += 1;
        return (await repo.countNumbered(sellerId)) + 1;
      },
    },
    now: () => Date.now() + clock.offset,
  });
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  app = new Hono();
  app.route("/invoices", invoiceRoutes(container, service, { strict: pass, publicRead: pass }, flag));
  token = await container.tokenFor(container.seller.id, container.seller.wallet);
  const other = await container.sellers.createIfAbsent("GOTHERSELLERWALLETFORINVOICETESTS");
  otherToken = await container.tokenFor(other.id, other.wallet);
});

beforeEach(() => {
  flag.invoicesEnabled = true;
  clock.offset = 0;
  railCanReceive.fail = false;
  audit.length = 0;
});

afterAll(() => {
  container.client.close();
});

function body(over: Record<string, unknown> = {}) {
  return {
    clientName: "Ada Obi",
    clientEmail: EMAIL,
    clientAddress: ADDRESS,
    notes: NOTES,
    assetCode: "USDC",
    lineItems: [
      { description: "Design work", quantity: 3, unitPrice: "0.1000001" },
      { description: "Hosting", quantity: 1, unitPrice: "30" },
    ],
    dueAt: Date.now() + 14 * DAY,
    ...over,
  };
}

async function call(method: string, path: string, opts: { json?: unknown; auth?: string | null } = {}) {
  const headers: Record<string, string> = {};
  const auth = opts.auth === undefined ? token : opts.auth;
  if (auth !== null) headers.authorization = `Bearer ${auth}`;
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`/invoices${path}`, {
    method,
    headers,
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : null) as Record<string, any> | null };
}

async function draft(over: Record<string, unknown> = {}) {
  const res = await call("POST", "", { json: body(over) });
  expect(res.status).toBe(201);
  return res.json!.invoice as Record<string, any>;
}

async function issued(over: Record<string, unknown> = {}) {
  const created = await draft(over);
  const res = await call("POST", `/${created.id}/issue`);
  expect(res.status).toBe(200);
  return res.json!.invoice as Record<string, any>;
}

async function setLinkStatus(linkId: string, status: LinkStatus) {
  const link = (await container.links.findById(linkId))!;
  link.status = status;
  await container.links.save(link);
}

async function mintKey(scopes: ApiKeyScope[]): Promise<string> {
  const { plaintext, prefix } = generateApiKey("live");
  await container.apiKeys.create({
    sellerId: container.seller.id,
    name: "invoice test key",
    prefix,
    hash: await hashApiKey(plaintext),
    scopes,
  });
  return plaintext;
}

const SELLER_ROUTES: Array<[string, string, unknown?]> = [
  ["GET", ""],
  ["PATCH", "", { notes: "x" }],
  ["DELETE", ""],
  ["POST", "/issue"],
  ["POST", "/void"],
];

describe("invoice lifecycle", () => {
  it("create draft -> patch -> issue -> public view -> void", async () => {
    const before = (await repo.countNumbered(container.seller.id)) + 1;
    const expectedNumber = `INV-${String(before).padStart(4, "0")}`;

    const created = await draft();
    expect(created).toMatchObject({
      sellerId: container.seller.id,
      number: null,
      linkId: null,
      issuedAt: null,
      state: "draft",
      status: "draft",
      clientName: "Ada Obi",
      clientEmail: EMAIL,
      clientAddress: ADDRESS,
      notes: NOTES,
      assetCode: "USDC",
      // 3 x 0.1000001 + 30, exactly.
      total: "30.3000003",
    });
    expect(created.id).toMatch(/^inv_/);

    const patched = await call("PATCH", `/${created.id}`, {
      json: { clientName: "Ada Obi Ltd", lineItems: [{ description: "Design work", quantity: 2, unitPrice: "12.5" }] },
    });
    expect(patched.status).toBe(200);
    expect(patched.json!.invoice).toMatchObject({ clientName: "Ada Obi Ltd", total: "25", state: "draft", clientEmail: EMAIL });

    const issue = await call("POST", `/${created.id}/issue`);
    expect(issue.status).toBe(200);
    const open = issue.json!.invoice;
    expect(open).toMatchObject({ number: expectedNumber, state: "open", status: "open" });
    expect(open.issuedAt).toEqual(expect.any(Number));

    const link = (await container.links.findById(open.linkId))!;
    expect(link).toMatchObject({
      title: `Invoice ${expectedNumber}`,
      amount: "25",
      sellerId: container.seller.id,
      status: "active",
      // An overdue invoice must stay payable.
      expiresAt: null,
    });
    expect(link.asset.code).toBe("USDC");

    const pub = await call("GET", `/${created.id}/public`, { auth: null });
    expect(pub.status).toBe(200);
    expect(pub.json).toMatchObject({ number: expectedNumber, clientName: "Ada Obi Ltd", total: "25", status: "open", linkId: open.linkId });

    const voided = await call("POST", `/${created.id}/void`);
    expect(voided.status).toBe(200);
    expect(voided.json!.invoice).toMatchObject({ state: "void", status: "void", number: expectedNumber });
    expect((await container.links.findById(open.linkId))!.status).toBe("cancelled");

    // Voiding again changes nothing.
    const again = await call("POST", `/${created.id}/void`);
    expect(again.status).toBe(200);
    expect(again.json!.invoice.state).toBe("void");
    expect((await call("GET", `/${created.id}/public`, { auth: null })).json!.status).toBe("void");
  });

  it("numbers a seller's invoices in the order they are issued", async () => {
    const first = await issued();
    const second = await issued();
    const n = (s: string) => Number(s.replace("INV-", ""));
    expect(first.number).toMatch(/^INV-\d{4,}$/);
    expect(n(second.number)).toBe(n(first.number) + 1);
  });

  it("deletes a draft", async () => {
    const created = await draft();
    expect((await call("DELETE", `/${created.id}`)).status).toBe(204);
    expect((await call("GET", `/${created.id}`)).status).toBe(404);
  });
});

describe("issuing when the seller cannot receive the asset", () => {
  it("returns the preflight's 422, leaves the invoice a draft and takes no number", async () => {
    const created = await draft();
    const numbered = await repo.countNumbered(container.seller.id);
    const calls = numbers.calls;
    railCanReceive.fail = true;

    const res = await call("POST", `/${created.id}/issue`);

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: "destination_cannot_receive", reason: "no_trustline" });
    expect(numbers.calls).toBe(calls);
    expect(await repo.countNumbered(container.seller.id)).toBe(numbered);
    const after = (await call("GET", `/${created.id}`)).json!.invoice;
    expect(after).toMatchObject({ state: "draft", number: null, linkId: null, issuedAt: null });

    // Once the seller can receive, the same draft issues with the next number: none was skipped.
    railCanReceive.fail = false;
    const ok = await call("POST", `/${created.id}/issue`);
    expect(ok.status).toBe(200);
    expect(ok.json!.invoice.number).toBe(`INV-${String(numbered + 1).padStart(4, "0")}`);
  });
});

describe("the public view", () => {
  it("has exactly the whitelisted keys, and none of the email, address, notes or seller id", async () => {
    const open = await issued();

    const pub = await call("GET", `/${open.id}/public`, { auth: null });

    expect(Object.keys(pub.json!).sort()).toEqual(
      ["assetCode", "clientName", "dueAt", "issuedAt", "lineItems", "linkId", "number", "sellerName", "status", "total"].sort(),
    );
    expect(pub.json!.sellerName).toBe(container.seller.name);
    for (const secret of [EMAIL, ADDRESS, NOTES, container.seller.id, container.seller.wallet]) {
      expect(pub.text).not.toContain(secret);
    }
  });

  it("does not show a draft", async () => {
    const created = await draft();
    const pub = await call("GET", `/${created.id}/public`, { auth: null });
    expect(pub.status).toBe(404);
    expect(pub.json).toEqual({ error: "not_found" });
  });

  it("answers 404 for an unknown id", async () => {
    expect((await call("GET", "/inv_does_not_exist/public", { auth: null })).status).toBe(404);
  });
});

describe("seller scoping and scopes", () => {
  it("answers 404 to another seller on every seller route, and changes nothing", async () => {
    const mine = await draft();
    for (const [method, suffix, json] of SELLER_ROUTES) {
      const res = await call(method, `/${mine.id}${suffix}`, { auth: otherToken, json });
      expect([method, suffix, res.status]).toEqual([method, suffix, 404]);
      expect(res.json).toEqual({ error: "not_found" });
    }
    expect((await call("GET", `/${mine.id}`)).json!.invoice).toMatchObject({ state: "draft", notes: NOTES });
    // And the other seller's list does not contain it.
    const theirs = await call("GET", "", { auth: otherToken });
    expect(theirs.json!.invoices).toEqual([]);
  });

  it("answers 401 without credentials on every seller route", async () => {
    const mine = await draft();
    expect((await call("POST", "", { auth: null, json: body() })).status).toBe(401);
    expect((await call("GET", "", { auth: null })).status).toBe(401);
    for (const [method, suffix, json] of SELLER_ROUTES) {
      expect((await call(method, `/${mine.id}${suffix}`, { auth: null, json })).status).toBe(401);
    }
  });

  it("answers 403 to an API key without invoices scopes", async () => {
    const mine = await draft();
    const key = await mintKey(["links:read", "links:write"]);
    expect((await call("POST", "", { auth: key, json: body() })).status).toBe(403);
    expect((await call("GET", "", { auth: key })).json).toEqual({ error: "missing_scope", required: "invoices:read" });
    for (const [method, suffix, json] of SELLER_ROUTES) {
      const res = await call(method, `/${mine.id}${suffix}`, { auth: key, json });
      expect([method, suffix, res.status]).toEqual([method, suffix, 403]);
    }
  });

  it("lets a key with invoices:read read but not write", async () => {
    const mine = await draft();
    const key = await mintKey(["invoices:read"]);
    expect((await call("GET", `/${mine.id}`, { auth: key })).status).toBe(200);
    expect((await call("GET", "", { auth: key })).status).toBe(200);
    expect((await call("PATCH", `/${mine.id}`, { auth: key, json: { notes: "x" } })).json).toEqual({
      error: "missing_scope",
      required: "invoices:write",
    });
  });

  it("gives a default API key both invoices scopes", () => {
    expect(DEFAULT_SCOPES).toEqual(expect.arrayContaining(["invoices:read", "invoices:write"]));
  });
});

describe("personal data", () => {
  it("stores the client's email and address encrypted", async () => {
    const created = await draft();

    const [row] = await container.db.select().from(invoices).where(eq(invoices.id, created.id));

    expect(row!.clientEmailEncrypted).not.toBeNull();
    expect(row!.clientAddressEncrypted).not.toBeNull();
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain(ADDRESS);
    expect(decryptSecret(row!.clientEmailEncrypted!)).toBe(EMAIL);
    expect(decryptSecret(row!.clientAddressEncrypted!)).toBe(ADDRESS);
  });

  it("stores null, not an encrypted empty value, when they are left out or cleared", async () => {
    const created = await draft({ clientEmail: undefined, clientAddress: null });
    expect(created).toMatchObject({ clientEmail: null, clientAddress: null });
    const withEmail = await draft();
    const cleared = await call("PATCH", `/${withEmail.id}`, { json: { clientEmail: null } });
    expect(cleared.json!.invoice).toMatchObject({ clientEmail: null, clientAddress: ADDRESS });
    const [row] = await container.db.select().from(invoices).where(eq(invoices.id, withEmail.id));
    expect(row!.clientEmailEncrypted).toBeNull();
  });

  it("records invoice.client.write with field names, never values", async () => {
    const created = await draft();
    expect(audit).toEqual([
      expect.objectContaining({
        sellerId: container.seller.id,
        actorType: "session",
        action: "invoice.client.write",
        fields: ["client_name", "client_email", "client_address"],
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(EMAIL);

    audit.length = 0;
    await call("PATCH", `/${created.id}`, { json: { clientAddress: "1 New Street" } });
    expect(audit.map((e) => [e.action, e.fields])).toEqual([["invoice.client.write", ["client_address"]]]);

    // A patch that touches no client field writes no audit row.
    audit.length = 0;
    await call("PATCH", `/${created.id}`, { json: { notes: "changed" } });
    expect(audit).toEqual([]);
  });
});

describe("state rules", () => {
  it("refuses to edit or delete an issued invoice with 409 invoice_not_draft", async () => {
    const open = await issued();
    for (const [method, json] of [["PATCH", { notes: "x" }], ["DELETE", undefined]] as const) {
      const res = await call(method, `/${open.id}`, { json });
      expect([method, res.status, res.json]).toEqual([method, 409, { error: "invoice_not_draft" }]);
    }
    const twice = await call("POST", `/${open.id}/issue`);
    expect([twice.status, twice.json]).toEqual([409, { error: "invoice_not_draft" }]);
    expect((await call("GET", `/${open.id}`)).json!.invoice).toMatchObject({ state: "open", notes: NOTES, number: open.number });
  });

  it.each(["paid", "offramp_pending", "offramp_settled", "offramp_failed"] as const)(
    "refuses to void an invoice whose link is %s with 409 invoice_already_paid",
    async (status) => {
      const open = await issued();
      await setLinkStatus(open.linkId, status);
      const res = await call("POST", `/${open.id}/void`);
      expect([res.status, res.json]).toEqual([409, { error: "invoice_already_paid" }]);
      expect((await call("GET", `/${open.id}`)).json!.invoice).toMatchObject({ state: "open", status: "paid" });
      expect((await container.links.findById(open.linkId))!.status).toBe(status);
    },
  );

  it("refuses to void a draft: it is edited or deleted instead", async () => {
    const created = await draft();
    const res = await call("POST", `/${created.id}/void`);
    expect([res.status, res.json]).toEqual([409, { error: "invoice_not_issued" }]);
  });

  it("answers 404 for an unknown invoice on every seller route", async () => {
    for (const [method, suffix, json] of SELLER_ROUTES) {
      expect((await call(method, `/inv_does_not_exist${suffix}`, { json })).status).toBe(404);
    }
  });

  it.each([
    [{ clientName: "" }, "an empty client name"],
    [{ lineItems: [] }, "no line items"],
    [{ lineItems: [{ description: "x", quantity: 1.5, unitPrice: "1" }] }, "a fractional quantity"],
    [{ lineItems: [{ description: "x", quantity: 1, unitPrice: "0.00000001" }] }, "an eighth decimal"],
    [{ dueAt: Date.now() - DAY }, "a due date in the past"],
    [{ clientEmail: "not-an-email" }, "a malformed email"],
  ] as [Record<string, unknown>, string][])("refuses a draft with %j (%s) as 400 invalid_body", async (over) => {
    const res = await call("POST", "", { json: body(over) });
    expect(res.status).toBe(400);
    expect(res.json!.error).toBe("invalid_body");
  });

  it("refuses line items whose sum is over the largest amount, though each line is valid", async () => {
    const huge = { description: "x", quantity: 100_000, unitPrice: "900000000000" };
    const res = await call("POST", "", { json: body({ lineItems: [huge] }) });
    expect(res.status).toBe(400);
    expect(res.json!.error).toBe("invalid_body");
  });
});

describe("GET /invoices", () => {
  it("filters by the derived status and pages with a cursor", async () => {
    // A seller of their own, so other tests' invoices do not get in the way.
    const seller = await container.sellers.createIfAbsent("GLISTSELLERWALLETFORINVOICETESTS");
    const auth = await container.tokenFor(seller.id, seller.wallet);
    const make = async (over: Record<string, unknown> = {}) =>
      (await call("POST", "", { auth, json: body(over) })).json!.invoice as Record<string, any>;
    const issue = async (id: string) => (await call("POST", `/${id}/issue`, { auth })).json!.invoice as Record<string, any>;

    const aDraft = await make();
    const open = await issue((await make()).id);
    const paid = await issue((await make()).id);
    await setLinkStatus(paid.linkId, "paid");
    const overdue = await issue((await make({ dueAt: Date.now() + DAY })).id);
    const voided = await issue((await make()).id);
    await call("POST", `/${voided.id}/void`, { auth });

    // Two days on, the invoice due tomorrow is overdue; the paid one is still paid.
    clock.offset = 2 * DAY;
    const by = async (status: string) =>
      ((await call("GET", `?status=${status}`, { auth })).json!.invoices as Array<Record<string, any>>).map((i) => i.id);
    expect(await by("draft")).toEqual([aDraft.id]);
    expect(await by("open")).toEqual([open.id]);
    expect(await by("paid")).toEqual([paid.id]);
    expect(await by("overdue")).toEqual([overdue.id]);
    expect(await by("void")).toEqual([voided.id]);

    const all = await call("GET", "", { auth });
    expect(all.json!.invoices).toHaveLength(5);
    expect(all.json!.nextCursor).toBeNull();
    // The list is the seller's own view: it carries the decrypted client fields.
    expect(all.json!.invoices[0]).toMatchObject({ clientEmail: EMAIL, status: expect.any(String) });

    // Pages of two: 2 + 2 + 1, no invoice twice, none missing.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof call>> = await call("GET", `?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { auth });
      expect(page.status).toBe(200);
      seen.push(...(page.json!.invoices as Array<Record<string, any>>).map((i) => i.id));
      cursor = page.json!.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen.slice().sort()).toEqual([aDraft.id, open.id, paid.id, overdue.id, voided.id].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it.each(["?status=late", "?limit=0", "?limit=abc", "?limit=201", "?cursor=!!"])("refuses %s with 400 invalid_query", async (query) => {
    const res = await call("GET", query);
    expect(res.status).toBe(400);
    expect(res.json!.error).toBe("invalid_query");
  });
});

describe("the flag", () => {
  it("answers 501 invoices_disabled on every route when invoices are off, before asking who is calling", async () => {
    const created = await draft();
    flag.invoicesEnabled = false;
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "", body()],
      ["GET", ""],
      ["GET", `/${created.id}/public`],
      ...SELLER_ROUTES.map(([m, s, j]) => [m, `/${created.id}${s}`, j] as [string, string, unknown?]),
    ];
    for (const [method, path, json] of routes) {
      for (const auth of [token, null]) {
        const res = await call(method, path, { auth, json });
        expect([method, path, res.status]).toEqual([method, path, 501]);
        expect(res.json).toEqual({ error: "invoices_disabled", message: "Invoices are not enabled on this deployment." });
      }
    }
    // Nothing happened while it was off.
    flag.invoicesEnabled = true;
    expect((await call("GET", `/${created.id}`)).json!.invoice).toMatchObject({ state: "draft", notes: NOTES });
  });
});
