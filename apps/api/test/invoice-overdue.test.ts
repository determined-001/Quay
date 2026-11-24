import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  LinkRepository,
  PaymentLink,
  Seller,
  Webhook,
  WebhookRepository,
  WebhookDelivery,
} from "@checkout/core";
import { InvoiceService, type Invoice, type InvoiceRepository } from "../src/services/invoice-service";
import { WebhookSender } from "../src/services/webhook-sender";
import { DrizzleInvoiceRepository, DrizzleLinkRepository, DrizzleSellerRepository } from "../src/repos/index";
import { createDb, bootstrap } from "../src/db/client";
import { WatcherLoop } from "../src/worker/watcher-loop";
import { LinkService } from "../src/services/link-service";
import { encryptSecret } from "../src/services/secret-crypto";

const SELLER_ID = "seller_1";
const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function mockLink(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref_1",
    sellerId: SELLER_ID,
    destination: DEST,
    muxedId: null,
    title: "Test invoice payment",
    amount: "100.00",
    asset: { code: "USDC", issuer: ISSUER },
    status: "active",
    txHash: null,
    payer: null,
    paidAmount: null,
    overpaidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    offrampFeeAmount: null,
    offrampFeeCurrency: null,
    offrampFeeSource: null,
    offrampNetTargetAmount: null,
    expiresAt: null,
    isDemo: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

class FakeLinkRepo implements LinkRepository {
  byId = new Map<string, PaymentLink>();
  async create(input: Parameters<LinkRepository["create"]>[0]): Promise<PaymentLink> {
    const created = mockLink({ id: input.id, reference: input.reference, sellerId: input.sellerId, title: input.title });
    this.byId.set(created.id, created);
    return created;
  }
  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }
  async findByReference(reference: string): Promise<PaymentLink | null> {
    for (const l of this.byId.values()) if (l.reference === reference) return l;
    return null;
  }
  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }
  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.status === status);
  }
  async activeDestinations(): Promise<string[]> {
    return [];
  }
  async openLinksForDestination(): Promise<PaymentLink[]> {
    return [];
  }
  async save(l: PaymentLink): Promise<void> {
    this.byId.set(l.id, { ...l, updatedAt: Date.now() });
  }
  async recordPayment(): Promise<void> {}
  async sumPaymentsForLink(): Promise<string> {
    return "0";
  }
  async paymentLedger(): Promise<number | null> {
    return null;
  }
  async claimForCashOut(): Promise<boolean> {
    return true;
  }
  async listPaymentsForLink(): Promise<any[]> {
    return [];
  }
  async releaseCashOutClaim(): Promise<void> {}
}

class FakeWebhookRepo implements WebhookRepository {
  stored: Webhook[] = [];
  queued: { id: string; webhookId: string; linkId: string; event: string; payload: string }[] = [];

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const w: Webhook = {
      id: `whk_${this.stored.length + 1}`,
      sellerId: input.sellerId,
      url: input.url,
      secretEncrypted: encryptSecret(input.secret),
      secretLast4: input.secret.slice(-4),
      previousSecretEncrypted: null,
      previousSecretLast4: null,
      previousSecretExpiresAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    };
    this.stored.push(w);
    return w;
  }
  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.stored.filter((w) => w.sellerId === sellerId && w.deletedAt === null);
  }
  async enqueue(e: { id: string; webhookId: string; linkId: string; event: string; payload: string; nextAttemptAt: number; createdAt: number }) {
    this.queued.push(e);
    return { ...e, attempts: 0, status: "pending" as const, lastStatusCode: null, lastError: null, updatedAt: e.createdAt };
  }
  async getById(): Promise<null> { return null; }
  async rotateSecret(): Promise<null> { return null; }
  async softDelete(): Promise<boolean> { return false; }
  async listDeliveries(): Promise<{ deliveries: never[]; nextCursor: null }> { return { deliveries: [], nextCursor: null }; }
  async reclaimStale(): Promise<number> { return 0; }
  async countPending(): Promise<number> { return 0; }
  async findWebhookById(): Promise<null> { return null; }
  async claimDue(): Promise<never[]> { return []; }
  async recordDelivery(): Promise<void> {}
  async updateQueueStatus(): Promise<void> {}
  async updateQueueEntry(): Promise<void> {}
  async findQueueEntry(): Promise<null> { return null; }
  async listDeliveriesByLinkId(): Promise<WebhookDelivery[]> { return []; }
  async findQueueEntryById(): Promise<null> { return null; }
  async listDeadLetters(): Promise<{ entries: never[]; nextCursor: null }> { return { entries: [], nextCursor: null }; }
  async retryQueueEntry(): Promise<null> { return null; }
}

class FakeInvoiceRepo implements InvoiceRepository {
  invoices = new Map<string, Invoice>();

  async create(input: Parameters<InvoiceRepository["create"]>[0]): Promise<Invoice> {
    const inv: Invoice = {
      id: input.id,
      sellerId: input.sellerId,
      linkId: input.linkId,
      number: input.number,
      clientName: input.clientName ?? null,
      clientEmail: input.clientEmail ?? null,
      total: input.total,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer ?? null,
      status: input.status ?? "open",
      dueAt: input.dueAt,
      overdueNotifiedAt: input.overdueNotifiedAt ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.invoices.set(inv.id, inv);
    return inv;
  }

  async findById(id: string): Promise<Invoice | null> {
    return this.invoices.get(id) ?? null;
  }

  async listCandidatesForOverdue(now: number): Promise<Invoice[]> {
    return [...this.invoices.values()].filter(
      (inv) => inv.status === "open" && inv.dueAt < now && inv.overdueNotifiedAt === null,
    );
  }

  async claimForOverdue(id: string, now: number): Promise<boolean> {
    const inv = this.invoices.get(id);
    if (!inv || inv.overdueNotifiedAt !== null) {
      return false;
    }
    inv.overdueNotifiedAt = now;
    inv.updatedAt = now;
    return true;
  }

  async releaseOverdueClaim(id: string): Promise<void> {
    const inv = this.invoices.get(id);
    if (inv) {
      inv.overdueNotifiedAt = null;
      inv.updatedAt = Date.now();
    }
  }
}

describe("InvoiceService.sweepOverdue", () => {
  let invoiceRepo: FakeInvoiceRepo;
  let linkRepo: FakeLinkRepo;
  let webhookRepo: FakeWebhookRepo;
  let webhookSender: WebhookSender;
  let service: InvoiceService;

  beforeEach(async () => {
    invoiceRepo = new FakeInvoiceRepo();
    linkRepo = new FakeLinkRepo();
    webhookRepo = new FakeWebhookRepo();
    webhookSender = new WebhookSender(webhookRepo);
    service = new InvoiceService({
      invoices: invoiceRepo,
      links: linkRepo,
      webhooks: webhookRepo,
      webhookSender,
      invoicesEnabled: true,
    });

    await webhookRepo.create({
      sellerId: SELLER_ID,
      url: "https://seller.example.com/webhooks",
      secret: "sec_12345678901234567890123456789012",
    });
  });

  it("an open, unpaid, past-due invoice fires exactly one invoice.overdue, with overdue_notified_at set", async () => {
    const link = mockLink({ id: "lnk_100", amount: "50.00", status: "active" });
    linkRepo.byId.set(link.id, link);

    const invoice = await invoiceRepo.create({
      id: "inv_1",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-001",
      total: "50.00",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      status: "open",
      dueAt: 1000,
    });

    const now = 2000;
    const moved = await service.sweepOverdue(now);
    expect(moved).toBe(1);

    const reloaded = await invoiceRepo.findById(invoice.id);
    expect(reloaded?.overdueNotifiedAt).toBe(now);

    expect(webhookRepo.queued).toHaveLength(1);
    const queued = webhookRepo.queued[0]!;
    expect(queued.event).toBe("invoice.overdue");
    expect(queued.linkId).toBe(link.id);

    const payload = JSON.parse(queued.payload);
    expect(payload.event).toBe("invoice.overdue");
    expect(payload.data).toEqual({
      invoiceId: "inv_1",
      number: "INV-001",
      linkId: "lnk_100",
      total: "50.00",
      paidAmount: null,
      asset: { code: "USDC", issuer: ISSUER },
      dueAt: 1000,
    });
  });

  it("running the sweep twice sequentially fires once", async () => {
    const link = mockLink({ id: "lnk_101", status: "active" });
    linkRepo.byId.set(link.id, link);

    await invoiceRepo.create({
      id: "inv_seq",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-SEQ",
      total: "100.00",
      assetCode: "USDC",
      status: "open",
      dueAt: 1000,
    });

    const first = await service.sweepOverdue(2000);
    expect(first).toBe(1);
    expect(webhookRepo.queued).toHaveLength(1);

    const second = await service.sweepOverdue(3000);
    expect(second).toBe(0);
    expect(webhookRepo.queued).toHaveLength(1);
  });

  it("not yet due: due_at >= now, including the exact boundary at due_at", async () => {
    const link = mockLink({ id: "lnk_boundary", status: "active" });
    linkRepo.byId.set(link.id, link);

    const dueAt = 5000;
    await invoiceRepo.create({
      id: "inv_bound",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-BOUND",
      total: "75.00",
      assetCode: "USDC",
      status: "open",
      dueAt,
    });

    // Before due: now < dueAt
    expect(await service.sweepOverdue(4999)).toBe(0);
    expect(webhookRepo.queued).toHaveLength(0);

    // Exact boundary: now == dueAt
    expect(await service.sweepOverdue(5000)).toBe(0);
    expect(webhookRepo.queued).toHaveLength(0);

    // Past due: now > dueAt
    expect(await service.sweepOverdue(5001)).toBe(1);
    expect(webhookRepo.queued).toHaveLength(1);
  });

  it("paid, void, and draft invoices never fire", async () => {
    const link = mockLink({ id: "lnk_other", status: "active" });
    linkRepo.byId.set(link.id, link);

    await invoiceRepo.create({
      id: "inv_draft",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-DRAFT",
      total: "10.00",
      assetCode: "USDC",
      status: "draft",
      dueAt: 1000,
    });

    await invoiceRepo.create({
      id: "inv_void",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-VOID",
      total: "20.00",
      assetCode: "USDC",
      status: "void",
      dueAt: 1000,
    });

    await invoiceRepo.create({
      id: "inv_paid",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-PAID",
      total: "30.00",
      assetCode: "USDC",
      status: "paid",
      dueAt: 1000,
    });

    // Open invoice whose link was marked paid
    const paidLink = mockLink({ id: "lnk_paid_link", status: "paid", paidAmount: "40.00" });
    linkRepo.byId.set(paidLink.id, paidLink);
    await invoiceRepo.create({
      id: "inv_link_paid",
      sellerId: SELLER_ID,
      linkId: paidLink.id,
      number: "INV-LP",
      total: "40.00",
      assetCode: "USDC",
      status: "open",
      dueAt: 1000,
    });

    const moved = await service.sweepOverdue(2000);
    expect(moved).toBe(0);
    expect(webhookRepo.queued).toHaveLength(0);
  });

  it("the payload key set is exactly invoiceId, number, linkId, total, paidAmount, asset, dueAt, with no client fields", async () => {
    const link = mockLink({ id: "lnk_pii", status: "active", paidAmount: "12.50" });
    linkRepo.byId.set(link.id, link);

    await invoiceRepo.create({
      id: "inv_pii",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-PII",
      clientName: "Alice Client",
      clientEmail: "alice@example.com",
      total: "100.00",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      status: "open",
      dueAt: 1000,
    });

    await service.sweepOverdue(2000);
    expect(webhookRepo.queued).toHaveLength(1);

    const queued = webhookRepo.queued[0]!;
    expect(queued.linkId).toBe(link.id);

    const payload = JSON.parse(queued.payload);
    const dataKeys = Object.keys(payload.data).sort();
    expect(dataKeys).toEqual([
      "asset",
      "dueAt",
      "invoiceId",
      "linkId",
      "number",
      "paidAmount",
      "total",
    ]);
    expect(payload.data.paidAmount).toBe("12.50");
    expect(payload.data).not.toHaveProperty("clientName");
    expect(payload.data).not.toHaveProperty("clientEmail");
  });

  it("one failing invoice does not stop the others", async () => {
    const linkA = mockLink({ id: "lnk_a", status: "active" });
    const linkB = mockLink({ id: "lnk_b", status: "active" });
    linkRepo.byId.set(linkA.id, linkA);
    linkRepo.byId.set(linkB.id, linkB);

    await invoiceRepo.create({
      id: "inv_fail_a",
      sellerId: SELLER_ID,
      linkId: linkA.id,
      number: "INV-A",
      total: "10.00",
      assetCode: "USDC",
      status: "open",
      dueAt: 1000,
    });

    await invoiceRepo.create({
      id: "inv_ok_b",
      sellerId: SELLER_ID,
      linkId: linkB.id,
      number: "INV-B",
      total: "20.00",
      assetCode: "USDC",
      status: "open",
      dueAt: 1000,
    });

    // Mock enqueue to fail specifically for inv_fail_a
    const origEnqueue = webhookSender.enqueue.bind(webhookSender);
    vi.spyOn(webhookSender, "enqueue").mockImplementation(async (hooks, linkId, event) => {
      if (linkId === "lnk_a") {
        throw new Error("Network timeout while writing to queue");
      }
      return origEnqueue(hooks, linkId, event);
    });

    const moved = await service.sweepOverdue(2000);
    // inv_ok_b succeeds
    expect(moved).toBe(1);

    // inv_fail_a claim was released on failure so it can be retried later
    const invA = await invoiceRepo.findById("inv_fail_a");
    expect(invA?.overdueNotifiedAt).toBeNull();

    // inv_ok_b was notified
    const invB = await invoiceRepo.findById("inv_ok_b");
    expect(invB?.overdueNotifiedAt).toBe(2000);
    expect(webhookRepo.queued).toHaveLength(1);
    expect(webhookRepo.queued[0]?.linkId).toBe("lnk_b");
  });

  it("the sweep does nothing when INVOICES_ENABLED=false", async () => {
    const disabledService = new InvoiceService({
      invoices: invoiceRepo,
      links: linkRepo,
      webhooks: webhookRepo,
      webhookSender,
      invoicesEnabled: false,
    });

    const link = mockLink({ id: "lnk_dis", status: "active" });
    linkRepo.byId.set(link.id, link);
    await invoiceRepo.create({
      id: "inv_dis",
      sellerId: SELLER_ID,
      linkId: link.id,
      number: "INV-DIS",
      total: "50.00",
      assetCode: "USDC",
      status: "open",
      dueAt: 1000,
    });

    const spyList = vi.spyOn(invoiceRepo, "listCandidatesForOverdue");
    const moved = await disabledService.sweepOverdue(2000);
    expect(moved).toBe(0);
    expect(spyList).not.toHaveBeenCalled();
    expect(webhookRepo.queued).toHaveLength(0);
  });
});

describe("DrizzleInvoiceRepository concurrency and atomic claim with real SQLite", () => {
  it("running the sweep twice CONCURRENTLY (Promise.all) fires exactly once", async () => {
    const { db, client } = createDb(":memory:");
    await bootstrap(client);

    const sellers = new DrizzleSellerRepository(db);
    const seller = await sellers.createIfAbsent("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV");
    const links = new DrizzleLinkRepository(db);
    const link = await links.create({
      id: "lnk_real_1",
      reference: "ref_real_1",
      sellerId: seller.id,
      destination: DEST,
      muxedId: null,
      title: "Real item",
      amount: "100.00",
      asset: { code: "USDC", issuer: ISSUER },
      expiresAt: null,
    });

    const drizzleInvoiceRepo = new DrizzleInvoiceRepository(db);
    await drizzleInvoiceRepo.create({
      id: "inv_real_concurrent",
      sellerId: seller.id,
      linkId: link.id,
      number: "INV-CONCURRENT",
      total: "100.00",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      status: "open",
      dueAt: 1000,
    });

    const fakeWebhookRepo = new FakeWebhookRepo();
    await fakeWebhookRepo.create({
      sellerId: seller.id,
      url: "https://seller.example.com/hooks",
      secret: "sec_12345678901234567890123456789012",
    });
    const sender = new WebhookSender(fakeWebhookRepo);

    const svc1 = new InvoiceService({
      invoices: drizzleInvoiceRepo,
      links,
      webhooks: fakeWebhookRepo,
      webhookSender: sender,
      invoicesEnabled: true,
    });

    const svc2 = new InvoiceService({
      invoices: drizzleInvoiceRepo,
      links,
      webhooks: fakeWebhookRepo,
      webhookSender: sender,
      invoicesEnabled: true,
    });

    const now = 2000;
    // Run two sweeps concurrently
    const [res1, res2] = await Promise.all([
      svc1.sweepOverdue(now),
      svc2.sweepOverdue(now),
    ]);

    // Exactly one sweep claimed and notified the row
    expect(res1 + res2).toBe(1);
    expect(fakeWebhookRepo.queued).toHaveLength(1);

    const row = await drizzleInvoiceRepo.findById("inv_real_concurrent");
    expect(row?.overdueNotifiedAt).toBe(now);
  });
});

describe("WatcherLoop tick integration with sweepOverdue", () => {
  it("an invoice whose link was paid in the same tick (payment matching, then sweep) never fires", async () => {
    const { db, client } = createDb(":memory:");
    await bootstrap(client);

    const sellers = new DrizzleSellerRepository(db);
    const seller = await sellers.createIfAbsent("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV");
    const links = new DrizzleLinkRepository(db);

    const link = await links.create({
      id: "lnk_tick_1",
      reference: "ref_tick_1",
      sellerId: seller.id,
      destination: DEST,
      muxedId: null,
      title: "Invoice link",
      amount: "100.00",
      asset: { code: "USDC", issuer: ISSUER },
      expiresAt: null,
    });

    const drizzleInvoiceRepo = new DrizzleInvoiceRepository(db);
    await drizzleInvoiceRepo.create({
      id: "inv_tick_1",
      sellerId: seller.id,
      linkId: link.id,
      number: "INV-TICK-1",
      total: "100.00",
      assetCode: "USDC",
      status: "open",
      dueAt: 1000,
    });

    const fakeWebhookRepo = new FakeWebhookRepo();
    await fakeWebhookRepo.create({
      sellerId: seller.id,
      url: "https://seller.example.com/hooks",
      secret: "sec_12345678901234567890123456789012",
    });
    const sender = new WebhookSender(fakeWebhookRepo);

    const invoiceService = new InvoiceService({
      invoices: drizzleInvoiceRepo,
      links,
      webhooks: fakeWebhookRepo,
      webhookSender: sender,
      invoicesEnabled: true,
    });

    // Simulate payment matched during the tick before sweep runs
    link.status = "paid";
    link.paidAmount = "100.00";
    await links.save(link);

    // Now sweep runs at the end of the tick
    const notified = await invoiceService.sweepOverdue(2000);
    expect(notified).toBe(0);
    expect(fakeWebhookRepo.queued).toHaveLength(0);

    const reloaded = await drizzleInvoiceRepo.findById("inv_tick_1");
    expect(reloaded?.overdueNotifiedAt).toBeNull();
  });

  it("watcher loop skips sweepOverdue when invoicesEnabled=false", async () => {
    const fakeService = {
      sweepExpired: vi.fn().mockResolvedValue(0),
    } as unknown as LinkService;

    const fakeInvoiceService = {
      sweepOverdue: vi.fn().mockResolvedValue(0),
    } as unknown as InvoiceService;

    const loop = new WatcherLoop({
      watcher: {
        fetchSince: vi.fn().mockResolvedValue([]),
      } as any,
      links: new FakeLinkRepo(),
      state: {
        getCursor: vi.fn().mockResolvedValue("0"),
        saveCursor: vi.fn().mockResolvedValue(undefined),
        isProcessed: vi.fn().mockResolvedValue(false),
        markProcessed: vi.fn().mockResolvedValue(undefined),
      } as any,
      service: fakeService,
      invoiceService: fakeInvoiceService,
      invoicesEnabled: false,
      pollMs: 1000,
    });

    await loop.runOnce();

    expect(fakeService.sweepExpired).toHaveBeenCalled();
    expect(fakeInvoiceService.sweepOverdue).not.toHaveBeenCalled();
  });
});
