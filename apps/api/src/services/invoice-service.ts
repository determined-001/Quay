import {
  formatInvoiceNumber,
  invoiceStatus,
  invoiceTotal,
  type CreateInvoiceBody,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceStatus,
  type LinkRepository,
  type LinkStatus,
  type SellerRepository,
  type UpdateInvoiceBody,
} from "@checkout/core";
import type { InvoicePageCursor, InvoiceRepository, StoredInvoice, StoredInvoicePatch } from "../repos/invoices";
import { newId } from "./ids";
import { HttpError, type LinkService } from "./link-service";
import { decryptSecret, encryptSecret } from "./secret-crypto";

/** The seller's own view of an invoice: everything, with the derived status. */
export type InvoiceView = Invoice & { status: InvoiceStatus };

/**
 * What anyone holding the invoice id may see (issue 4.67). A whitelist: the
 * client's email and address, the notes and the seller's id are never part of
 * it, so they cannot leak by a field being added to the invoice later.
 */
export interface PublicInvoiceView {
  number: string | null;
  sellerName: string;
  clientName: string;
  lineItems: InvoiceLineItem[];
  total: string;
  assetCode: Invoice["assetCode"];
  issuedAt: number | null;
  dueAt: number;
  status: InvoiceStatus;
  linkId: string | null;
}

/** Allocates the next invoice number of a seller. Issue 4.68 owns the real one. */
export interface InvoiceNumberAllocator {
  next(sellerId: string): Promise<number>;
}

export const INVOICE_PAGE_DEFAULT = 50;
export const INVOICE_PAGE_MAX = 200;

const PAID_LINK_STATUSES: ReadonlySet<LinkStatus> = new Set([
  "paid",
  "offramp_pending",
  "offramp_settled",
  "offramp_failed",
]);

export function encodeInvoiceCursor(cursor: InvoicePageCursor): string {
  return Buffer.from(`${cursor.createdAt}:${cursor.id}`, "utf8").toString("base64url");
}

export function decodeInvoiceCursor(raw: string): InvoicePageCursor | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const at = text.indexOf(":");
  if (at <= 0) return null;
  const createdAt = Number(text.slice(0, at));
  const id = text.slice(at + 1);
  if (!Number.isSafeInteger(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

const encryptOptional = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value === "" ? null : encryptSecret(value);

export class InvoiceService {
  constructor(
    private readonly deps: {
      invoices: InvoiceRepository;
      links: Pick<LinkRepository, "findById">;
      sellers: Pick<SellerRepository, "findById">;
      linkService: Pick<LinkService, "createLink" | "cancelLink" | "assertSellerCanReceive">;
      numbers: InvoiceNumberAllocator;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The seller's invoice, or a 404 that does not say whether the id exists (issue #41). */
  private async owned(sellerId: string, id: string): Promise<StoredInvoice> {
    const invoice = await this.deps.invoices.findById(id);
    if (!invoice || invoice.sellerId !== sellerId) throw new HttpError(404, "not_found");
    return invoice;
  }

  private async linkStatus(invoice: Pick<StoredInvoice, "linkId">): Promise<LinkStatus | null> {
    if (!invoice.linkId) return null;
    return (await this.deps.links.findById(invoice.linkId))?.status ?? null;
  }

  private async view(invoice: StoredInvoice): Promise<InvoiceView> {
    const { clientEmailEncrypted, clientAddressEncrypted, ...rest } = invoice;
    return {
      ...rest,
      clientEmail: clientEmailEncrypted === null ? null : decryptSecret(clientEmailEncrypted),
      clientAddress: clientAddressEncrypted === null ? null : decryptSecret(clientAddressEncrypted),
      status: invoiceStatus(invoice, await this.linkStatus(invoice), this.now()),
    };
  }

  /** The exact total, or a 400: the schema bounds each line, not their sum. */
  private total(lineItems: InvoiceLineItem[]): string {
    try {
      return invoiceTotal(lineItems);
    } catch (err) {
      throw new HttpError(400, "invalid_body", { message: err instanceof Error ? err.message : "invalid line items" });
    }
  }

  /** Creates a draft. It has no number and no payment link until it is issued. */
  async createDraft(sellerId: string, body: CreateInvoiceBody): Promise<InvoiceView> {
    const now = this.now();
    const invoice: StoredInvoice = {
      id: newId("inv"),
      sellerId,
      number: null,
      linkId: null,
      clientName: body.clientName,
      clientEmailEncrypted: encryptOptional(body.clientEmail),
      clientAddressEncrypted: encryptOptional(body.clientAddress),
      notes: body.notes ? body.notes : null,
      assetCode: body.assetCode,
      lineItems: body.lineItems,
      total: this.total(body.lineItems),
      issuedAt: null,
      dueAt: body.dueAt,
      state: "draft",
      overdueNotifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.invoices.create(invoice);
    return this.view(invoice);
  }

  /** Edits a draft. An issued invoice is never edited: void it and issue a new one. */
  async updateDraft(sellerId: string, id: string, body: UpdateInvoiceBody): Promise<InvoiceView> {
    const invoice = await this.owned(sellerId, id);
    if (invoice.state !== "draft") throw new HttpError(409, "invoice_not_draft");

    const patch: StoredInvoicePatch = {};
    if (body.clientName !== undefined) patch.clientName = body.clientName;
    if (body.clientEmail !== undefined) patch.clientEmailEncrypted = encryptOptional(body.clientEmail);
    if (body.clientAddress !== undefined) patch.clientAddressEncrypted = encryptOptional(body.clientAddress);
    if (body.notes !== undefined) patch.notes = body.notes ? body.notes : null;
    if (body.assetCode !== undefined) patch.assetCode = body.assetCode;
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt;
    if (body.lineItems !== undefined) {
      patch.lineItems = body.lineItems;
      patch.total = this.total(body.lineItems);
    }

    // Conditional on still being a draft, so an edit cannot land on an invoice
    // that was issued between the read above and this write.
    if (!(await this.deps.invoices.transition(id, "draft", patch, this.now()))) {
      throw new HttpError(409, "invoice_not_draft");
    }
    return this.view((await this.deps.invoices.findById(id)) ?? invoice);
  }

  async deleteDraft(sellerId: string, id: string): Promise<void> {
    const invoice = await this.owned(sellerId, id);
    if (invoice.state !== "draft" || !(await this.deps.invoices.deleteDraft(id))) {
      throw new HttpError(409, "invoice_not_draft");
    }
  }

  /**
   * Issues a draft: it gets a payment link and a number, and becomes `open`.
   *
   * In this order, because the link's title carries the number and a link
   * cannot be renamed:
   *
   * 1. The trustline preflight. When the seller cannot receive the asset its
   *    422 passes through, the invoice is still a draft and no number was taken.
   * 2. The draft is claimed, as one conditional write. Of two requests that
   *    issue the same draft one loses here, before a number or a link exists.
   * 3. The number is allocated (4.68) and the link created, with no expiry:
   *    an overdue invoice must stay payable.
   *
   * If step 3 fails the invoice goes back to a draft. A number allocated
   * just before that failure is not handed out again.
   */
  async issue(sellerId: string, id: string): Promise<InvoiceView> {
    const invoice = await this.owned(sellerId, id);
    if (invoice.state !== "draft") throw new HttpError(409, "invoice_not_draft");

    await this.deps.linkService.assertSellerCanReceive(sellerId, invoice.assetCode, invoice.total);

    const issuedAt = this.now();
    if (!(await this.deps.invoices.transition(id, "draft", { state: "open", issuedAt }, issuedAt))) {
      throw new HttpError(409, "invoice_not_draft");
    }

    try {
      const number = formatInvoiceNumber(await this.deps.numbers.next(sellerId));
      const { link } = await this.deps.linkService.createLink(sellerId, {
        title: `Invoice ${number}`,
        amount: invoice.total,
        assetCode: invoice.assetCode,
      });
      const issued = await this.deps.invoices.update(id, { number, linkId: link.id }, issuedAt);
      return this.view(issued ?? { ...invoice, state: "open", linkId: link.id, issuedAt, number });
    } catch (err) {
      // An open invoice without a number or a link must not stay: put the draft back.
      await this.deps.invoices.transition(id, "open", { state: "draft", linkId: null, issuedAt: null, number: null });
      throw err;
    }
  }

  /** Voids an issued invoice and cancels its link. Voiding twice is a no-op. */
  async void(sellerId: string, id: string): Promise<InvoiceView> {
    const invoice = await this.owned(sellerId, id);
    if (invoice.state === "void") return this.view(invoice);
    // A draft has nothing to void: it is edited or deleted.
    if (invoice.state === "draft") throw new HttpError(409, "invoice_not_issued");

    const status = await this.linkStatus(invoice);
    if (status !== null && PAID_LINK_STATUSES.has(status)) throw new HttpError(409, "invoice_already_paid");
    if (invoice.linkId) {
      try {
        await this.deps.linkService.cancelLink(invoice.linkId);
      } catch (err) {
        // The link was paid between the check above and the cancel.
        if (err instanceof HttpError && err.status === 409) throw new HttpError(409, "invoice_already_paid");
        throw err;
      }
    }
    const voided = await this.deps.invoices.update(id, { state: "void" }, this.now());
    return this.view(voided ?? { ...invoice, state: "void" });
  }

  async get(sellerId: string, id: string): Promise<InvoiceView> {
    return this.view(await this.owned(sellerId, id));
  }

  /**
   * A page of the seller's invoices, newest first. The status is derived from
   * the link and the clock, so a `status` filter is applied after reading:
   * pages are read until `limit` invoices match or there are no more.
   */
  async list(
    sellerId: string,
    opts: { status?: InvoiceStatus; cursor?: InvoicePageCursor; limit?: number } = {},
  ): Promise<{ invoices: InvoiceView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? INVOICE_PAGE_DEFAULT, 1), INVOICE_PAGE_MAX);
    const matched: InvoiceView[] = [];
    let before = opts.cursor;
    for (;;) {
      const page = await this.deps.invoices.listBySeller(sellerId, { limit: limit + 1, before });
      for (const row of page.slice(0, limit)) {
        const view = await this.view(row);
        if (opts.status === undefined || view.status === opts.status) matched.push(view);
        before = { createdAt: row.createdAt, id: row.id };
        if (matched.length === limit) {
          // More rows after this one may still match; the cursor says where to look.
          const more = page.length > page.indexOf(row) + 1;
          return { invoices: matched, nextCursor: more ? encodeInvoiceCursor(before) : null };
        }
      }
      if (page.length <= limit) return { invoices: matched, nextCursor: null };
    }
  }

  /** The public view. A draft is not public: it reads as not found. */
  async getPublic(id: string): Promise<PublicInvoiceView> {
    const invoice = await this.deps.invoices.findById(id);
    if (!invoice || invoice.state === "draft") throw new HttpError(404, "not_found");
    const seller = await this.deps.sellers.findById(invoice.sellerId);
    return {
      number: invoice.number,
      sellerName: seller?.name ?? "",
      clientName: invoice.clientName,
      lineItems: invoice.lineItems,
      total: invoice.total,
      assetCode: invoice.assetCode,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      status: invoiceStatus(invoice, await this.linkStatus(invoice), this.now()),
      linkId: invoice.linkId,
    };
  }
}
