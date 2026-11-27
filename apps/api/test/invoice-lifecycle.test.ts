import { describe, expect, it } from "vitest";
import { FakeLinkRepository, FakeWebhookRepository } from "./fakes";
import { InvoiceService } from "../src/services/invoice-service";

describe("Invoice lifecycle integration (issue 5.55)", () => {
  it("runs issue -> matched payment -> derived paid", async () => {
    const links = new FakeLinkRepository([]);
    const webhooks = new FakeWebhookRepository();
    const service = new InvoiceService({ links, webhooks });

    // 1. Create a draft invoice
    const draft = await service.createDraft({
      sellerId: "sel_1",
      clientName: "Acme Corp",
      lineItems: [
        { description: "Development", quantity: 2, unitPrice: "50.00" },
        { description: "Hosting", quantity: 1, unitPrice: "25.00" },
      ],
      asset: { code: "USDC" },
      dueAt: Date.now() + 86400000,
    });
    expect(draft.status).toBe("draft");
    expect(draft.number).toBeNull();
    expect(draft.total).toBe("125.00");

    // 2. Issue invoice
    const issued = await service.issue(draft.id, "sel_1");
    expect(issued.number).toBe("INV-0001");
    expect(issued.status).toBe("open");
    expect(issued.linkId).toBeDefined();

    // Link was created in FakeLinkRepository
    const link = await links.findById(issued.linkId!);
    expect(link).toBeDefined();
    expect(link?.amount).toBe("125.00");
    expect(link?.status).toBe("active");

    // 3. Matched payment occurs (link becomes paid)
    link!.status = "paid";
    link!.paidAmount = "125.00";
    link!.txHash = "tx_mock";
    await links.save(link!);

    // 4. Derived status of invoice is now "paid"
    const paidInvoice = await service.getInvoice(issued.id, "sel_1");
    expect(paidInvoice?.status).toBe("paid");
  });

  it("runs issue -> overdue sweep -> exactly one invoice.overdue queued", async () => {
    const links = new FakeLinkRepository([]);
    const webhooks = new FakeWebhookRepository();
    const service = new InvoiceService({ links, webhooks });
    const now = Date.now();

    // 1. Issue an invoice with past due date
    const draft = await service.createDraft({
      sellerId: "sel_1",
      clientName: "Late Payer Ltd",
      lineItems: [{ description: "Retainer", quantity: 1, unitPrice: "200.00" }],
      asset: { code: "USDC" },
      dueAt: now - 3600000, // 1 hour ago
    });

    const issued = await service.issue(draft.id, "sel_1");
    expect(issued.status).toBe("overdue"); // derived as overdue because dueAt < now

    // Webhook queue is initially empty
    expect(webhooks.queue).toHaveLength(0);

    // 2. Run overdue sweep
    const sweptCount = await service.sweepOverdue(now);
    expect(sweptCount).toBe(1);

    // Exactly one invoice.overdue webhook entry queued
    expect(webhooks.queue).toHaveLength(1);
    expect(webhooks.queue[0]?.event).toBe("invoice.overdue");
    const payload = JSON.parse(webhooks.queue[0]?.payload || "{}");
    expect(payload.invoiceId).toBe(issued.id);
    expect(payload.number).toBe("INV-0001");
    expect(payload.total).toBe("200.00");

    // 3. A second overdue sweep does not re-queue
    const secondSweep = await service.sweepOverdue(now + 1000);
    expect(secondSweep).toBe(0);
    expect(webhooks.queue).toHaveLength(1);
  });
});
