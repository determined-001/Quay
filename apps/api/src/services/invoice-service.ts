import { newId } from "./ids";
import type { LinkRepository, WebhookRepository, PaymentLink } from "@checkout/core";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: string;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "overdue" | "void";

export interface StoredInvoice {
  id: string;
  sellerId: string;
  number: string | null;
  clientName: string;
  clientEmail?: string | null;
  clientAddress?: string | null;
  lineItems: InvoiceLineItem[];
  total: string;
  asset: { code: string; issuer?: string | null };
  status: InvoiceStatus;
  dueAt: number;
  issuedAt: number | null;
  overdueNotifiedAt: number | null;
  linkId: string | null;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}

export function calculateInvoiceTotal(lineItems: InvoiceLineItem[]): string {
  let totalStroops = 0n;
  for (const item of lineItems) {
    const [whole, frac = ""] = item.unitPrice.split(".");
    const fracPadded = (frac + "0000000").slice(0, 7);
    const itemStroops = BigInt(whole || "0") * 10_000_000n + BigInt(fracPadded);
    totalStroops += BigInt(item.quantity) * itemStroops;
  }
  const wholePart = totalStroops / 10_000_000n;
  const fracPart = totalStroops % 10_000_000n;
  if (fracPart === 0n) return `${wholePart}.00`;
  const fracStr = fracPart.toString().padStart(7, "0").replace(/0+$/, "");
  return `${wholePart}.${fracStr.length === 1 ? fracStr + "0" : fracStr}`;
}

export function deriveInvoiceStatus(
  inv: StoredInvoice,
  link?: PaymentLink | null,
  now: number = Date.now(),
): InvoiceStatus {
  if (inv.status === "draft" || inv.status === "void") {
    return inv.status;
  }
  if (link && (link.status === "paid" || link.status.startsWith("offramp_"))) {
    return "paid";
  }
  if (link && link.status === "cancelled") {
    return "void";
  }
  if (inv.dueAt < now) {
    return "overdue";
  }
  return "open";
}

export interface InvoiceServiceDeps {
  links: LinkRepository;
  webhooks?: WebhookRepository;
  linkCreator?: (input: { sellerId: string; amount: string; title: string; assetCode?: string }) => Promise<PaymentLink>;
  counter?: { next(sellerId: string): Promise<number> };
}

export class InvoiceService {
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly sellerCounters = new Map<string, number>();

  constructor(private readonly deps: InvoiceServiceDeps) {}

  async createDraft(input: {
    sellerId: string;
    clientName: string;
    clientEmail?: string;
    clientAddress?: string;
    lineItems: InvoiceLineItem[];
    asset?: { code: string; issuer?: string | null };
    dueAt: number;
    notes?: string;
  }): Promise<StoredInvoice> {
    const id = newId("inv");
    const total = calculateInvoiceTotal(input.lineItems);
    const now = Date.now();
    const invoice: StoredInvoice = {
      id,
      sellerId: input.sellerId,
      number: null,
      clientName: input.clientName,
      clientEmail: input.clientEmail,
      clientAddress: input.clientAddress,
      lineItems: input.lineItems,
      total,
      asset: input.asset ?? { code: "USDC" },
      status: "draft",
      dueAt: input.dueAt,
      issuedAt: null,
      overdueNotifiedAt: null,
      linkId: null,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };
    this.invoices.set(id, invoice);
    return { ...invoice };
  }

  async patchDraft(
    id: string,
    sellerId: string,
    patch: Partial<Pick<StoredInvoice, "clientName" | "clientEmail" | "clientAddress" | "lineItems" | "dueAt" | "notes">>,
  ): Promise<StoredInvoice> {
    const inv = this.invoices.get(id);
    if (!inv || inv.sellerId !== sellerId) throw new Error("not_found");
    if (inv.status !== "draft") throw new Error("invoice_not_draft");

    if (patch.clientName !== undefined) inv.clientName = patch.clientName;
    if (patch.clientEmail !== undefined) inv.clientEmail = patch.clientEmail;
    if (patch.clientAddress !== undefined) inv.clientAddress = patch.clientAddress;
    if (patch.notes !== undefined) inv.notes = patch.notes;
    if (patch.dueAt !== undefined) inv.dueAt = patch.dueAt;
    if (patch.lineItems !== undefined) {
      inv.lineItems = patch.lineItems;
      inv.total = calculateInvoiceTotal(patch.lineItems);
    }
    inv.updatedAt = Date.now();
    return { ...inv };
  }

  async issue(id: string, sellerId: string): Promise<StoredInvoice> {
    const inv = this.invoices.get(id);
    if (!inv || inv.sellerId !== sellerId) throw new Error("not_found");
    if (inv.status !== "draft") throw new Error("invoice_not_draft");

    let num: number;
    if (this.deps.counter) {
      num = await this.deps.counter.next(sellerId);
    } else {
      const cur = (this.sellerCounters.get(sellerId) ?? 0) + 1;
      this.sellerCounters.set(sellerId, cur);
      num = cur;
    }
    const formattedNumber = `INV-${String(num).padStart(4, "0")}`;

    let link: PaymentLink;
    if (this.deps.linkCreator) {
      link = await this.deps.linkCreator({
        sellerId,
        amount: inv.total,
        title: `Invoice ${formattedNumber}`,
        assetCode: inv.asset.code,
      });
    } else {
      link = await this.deps.links.create({
        id: newId("lnk"),
        reference: `inv_${inv.id.slice(-8)}`,
        sellerId,
        destination: "GB4UZMDW2P4WITZ3DFPFIU6B7NRHBDDP5UQ2BUENI3LJQOX2YC2U7FJB",
        muxedId: null,
        title: `Invoice ${formattedNumber}`,
        amount: inv.total,
        asset: { code: inv.asset.code, issuer: inv.asset.issuer ?? null },
        expiresAt: null,
        isDemo: false,
      });
    }

    inv.number = formattedNumber;
    inv.linkId = link.id;
    inv.issuedAt = Date.now();
    inv.status = "open";
    inv.updatedAt = Date.now();

    const linkRow = await this.deps.links.findById(inv.linkId);
    const derived = deriveInvoiceStatus(inv, linkRow);
    return { ...inv, status: derived };
  }

  async void(id: string, sellerId: string): Promise<StoredInvoice> {
    const inv = this.invoices.get(id);
    if (!inv || inv.sellerId !== sellerId) throw new Error("not_found");
    if (inv.status === "draft") throw new Error("invoice_not_issued");
    const link = inv.linkId ? await this.deps.links.findById(inv.linkId) : null;
    if (link && (link.status === "paid" || link.status.startsWith("offramp_"))) {
      throw new Error("invoice_already_paid");
    }

    if (inv.linkId) {
      const link = await this.deps.links.findById(inv.linkId);
      if (link) {
        link.status = "cancelled";
        await this.deps.links.save(link);
      }
    }
    inv.status = "void";
    inv.updatedAt = Date.now();
    return { ...inv };
  }

  async getInvoice(id: string, sellerId?: string): Promise<StoredInvoice | null> {
    const inv = this.invoices.get(id);
    if (!inv) return null;
    if (sellerId && inv.sellerId !== sellerId) return null;
    const link = inv.linkId ? await this.deps.links.findById(inv.linkId) : null;
    return { ...inv, status: deriveInvoiceStatus(inv, link) };
  }

  async listInvoices(sellerId: string, statusFilter?: string): Promise<StoredInvoice[]> {
    const result: StoredInvoice[] = [];
    for (const inv of this.invoices.values()) {
      if (inv.sellerId !== sellerId) continue;
      const link = inv.linkId ? await this.deps.links.findById(inv.linkId) : null;
      const derived = deriveInvoiceStatus(inv, link);
      if (!statusFilter || statusFilter === "all" || derived === statusFilter) {
        result.push({ ...inv, status: derived });
      }
    }
    return result;
  }

  async sweepOverdue(now: number = Date.now()): Promise<number> {
    let swept = 0;
    for (const inv of this.invoices.values()) {
      if (inv.status !== "open" || inv.overdueNotifiedAt !== null || inv.dueAt >= now) continue;
      const link = inv.linkId ? await this.deps.links.findById(inv.linkId) : null;
      if (link && (link.status === "paid" || link.status.startsWith("offramp_") || link.status === "cancelled")) {
        continue;
      }
      inv.overdueNotifiedAt = now;
      if (this.deps.webhooks) {
        await this.deps.webhooks.enqueue({
          id: newId("whk_q"),
          webhookId: "whk_1",
          linkId: inv.linkId ?? null,
          event: "invoice.overdue",
          payload: JSON.stringify({
            invoiceId: inv.id,
            number: inv.number,
            linkId: inv.linkId,
            total: inv.total,
            dueAt: inv.dueAt,
          }),
          nextAttemptAt: now,
          createdAt: now,
        });
      }
      swept += 1;
    }
    return swept;
  }
}
