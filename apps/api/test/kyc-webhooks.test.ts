import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { AnchorCustomer, KycPort, KycRecord, Webhook } from "@checkout/core";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { DrizzleKycRepository, DrizzleWebhookRepository } from "../src/repos/index";
import { WebhookSender } from "../src/services/webhook-sender";
import { KycEvents } from "../src/services/kyc-events";
import { webhookQueue } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function makeTestSetup() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);

  const kycRepo = new DrizzleKycRepository(db, randomBytes(32));
  const webhookRepo = new DrizzleWebhookRepository(db);
  const sender = new WebhookSender(webhookRepo);

  // Register a webhook for seller sel_1
  const hook = await webhookRepo.create({
    sellerId: "sel_1",
    url: "https://example.com/webhook",
    secret: "test_secret_12345",
  });

  return { db, kycRepo, webhookRepo, sender, hook };
}

class FakeKycPort implements KycPort {
  recordToReturn: KycRecord;

  constructor(initial: KycRecord) {
    this.recordToReturn = initial;
  }

  async status(_customer: AnchorCustomer): Promise<KycRecord> {
    return this.recordToReturn;
  }

  async submit(_customer: AnchorCustomer, _fields: Record<string, string>): Promise<KycRecord> {
    return this.recordToReturn;
  }
}

describe("KycEvents Webhook Delivery", () => {
  const customer: AnchorCustomer = {
    sellerId: "sel_1",
    account: "GSELLER1",
  };

  it("enqueues kyc.accepted on status transition to ACCEPTED", async () => {
    const { db, kycRepo, webhookRepo, sender } = await makeTestSetup();

    // Initial state in repo is null (or PROCESSING)
    const innerPort = new FakeKycPort({
      sellerId: "sel_1",
      account: "GSELLER1",
      customerId: "cust_1",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: { first_name: "Alice", sensitive_ssn: "000-11-2222" },
      message: null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const kycEvents = new KycEvents({
      inner: innerPort,
      repo: kycRepo,
      webhooks: webhookRepo,
      sender,
      anchorDomain: "testanchor.stellar.org",
    });

    await kycEvents.status(customer);

    const queued = await db.select().from(webhookQueue);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.event).toBe("kyc.accepted");
    expect(queued[0]?.linkId).toBeNull();

    const parsed = JSON.parse(queued[0]!.payload);
    expect(parsed.event).toBe("kyc.accepted");
    expect(parsed.id).toBe("sel_1");
    expect(parsed.data).toEqual({
      anchorDomain: "testanchor.stellar.org",
      status: "ACCEPTED",
      previousStatus: null,
      missingFields: [],
      message: null,
    });

    // PII check: payload must not contain provided field values
    expect(queued[0]!.payload).not.toContain("Alice");
    expect(queued[0]!.payload).not.toContain("000-11-2222");
  });

  it("does not enqueue when status has not changed (idempotent)", async () => {
    const { db, kycRepo, webhookRepo, sender } = await makeTestSetup();

    // Save existing record with status ACCEPTED
    await kycRepo.save({
      sellerId: "sel_1",
      account: "GSELLER1",
      customerId: "cust_1",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const innerPort = new FakeKycPort({
      sellerId: "sel_1",
      account: "GSELLER1",
      customerId: "cust_1",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const kycEvents = new KycEvents({
      inner: innerPort,
      repo: kycRepo,
      webhooks: webhookRepo,
      sender,
      anchorDomain: "testanchor.stellar.org",
    });

    await kycEvents.status(customer);

    const queued = await db.select().from(webhookQueue);
    expect(queued).toHaveLength(0);
  });

  it("enqueues kyc.needs_info with missing field names only and message null", async () => {
    const { db, kycRepo, webhookRepo, sender } = await makeTestSetup();

    const innerPort = new FakeKycPort({
      sellerId: "sel_1",
      account: "GSELLER1",
      customerId: "cust_1",
      status: "NEEDS_INFO",
      requiredFields: [
        { name: "id_document", type: "binary", optional: false },
        { name: "phone_number", type: "string", optional: true },
      ],
      providedFields: { first_name: "Alice" },
      message: "Please upload ID",
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const kycEvents = new KycEvents({
      inner: innerPort,
      repo: kycRepo,
      webhooks: webhookRepo,
      sender,
      anchorDomain: "testanchor.stellar.org",
    });

    await kycEvents.status(customer);

    const queued = await db.select().from(webhookQueue);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.event).toBe("kyc.needs_info");

    const parsed = JSON.parse(queued[0]!.payload);
    expect(parsed.data.missingFields).toEqual(["id_document"]);
    // message is null for non-rejected events to avoid leaking sensitive anchor comments
    expect(parsed.data.message).toBeNull();
  });

  it("enqueues kyc.rejected with message included", async () => {
    const { db, kycRepo, webhookRepo, sender } = await makeTestSetup();

    // Previous status was NEEDS_INFO
    await kycRepo.save({
      sellerId: "sel_1",
      account: "GSELLER1",
      customerId: "cust_1",
      status: "NEEDS_INFO",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const innerPort = new FakeKycPort({
      sellerId: "sel_1",
      account: "GSELLER1",
      customerId: "cust_1",
      status: "REJECTED",
      requiredFields: [],
      providedFields: {},
      message: "Document expired or unreadable",
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const kycEvents = new KycEvents({
      inner: innerPort,
      repo: kycRepo,
      webhooks: webhookRepo,
      sender,
      anchorDomain: "testanchor.stellar.org",
    });

    await kycEvents.submit(customer, {});

    const queued = await db.select().from(webhookQueue);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.event).toBe("kyc.rejected");

    const parsed = JSON.parse(queued[0]!.payload);
    expect(parsed.data).toEqual({
      anchorDomain: "testanchor.stellar.org",
      status: "REJECTED",
      previousStatus: "NEEDS_INFO",
      missingFields: [],
      message: "Document expired or unreadable",
    });
  });

  it("handles sellers with no registered webhooks without error", async () => {
    const { db, kycRepo, webhookRepo, sender } = await makeTestSetup();

    const otherCustomer: AnchorCustomer = {
      sellerId: "sel_unregistered",
      account: "GOTHER",
    };

    const innerPort = new FakeKycPort({
      sellerId: "sel_unregistered",
      account: "GOTHER",
      customerId: "cust_2",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const kycEvents = new KycEvents({
      inner: innerPort,
      repo: kycRepo,
      webhooks: webhookRepo,
      sender,
      anchorDomain: "testanchor.stellar.org",
    });

    await expect(kycEvents.status(otherCustomer)).resolves.toBeDefined();
    const queued = await db.select().from(webhookQueue);
    expect(queued).toHaveLength(0);
  });
});
