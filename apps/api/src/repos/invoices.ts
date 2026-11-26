import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Invoice, InvoiceLineItem, InvoiceState } from "@checkout/core";
import type { DB } from "../db/client";
import { invoices } from "../db/schema";

/**
 * An invoice as it is stored (issue 4.67). The client's email and address are
 * personal data about someone who is not a Quay user, so they stay encrypted
 * here: the repository never sees the plaintext, and a caller that does not
 * need it (the public view) never decrypts it.
 */
export type StoredInvoice = Omit<Invoice, "clientEmail" | "clientAddress"> & {
  clientEmailEncrypted: string | null;
  clientAddressEncrypted: string | null;
};

export type StoredInvoicePatch = Partial<
  Pick<
    StoredInvoice,
    | "number"
    | "linkId"
    | "clientName"
    | "clientEmailEncrypted"
    | "clientAddressEncrypted"
    | "notes"
    | "assetCode"
    | "lineItems"
    | "total"
    | "issuedAt"
    | "dueAt"
    | "state"
  >
>;

/** Where a page of a seller's invoices starts: strictly older than this row. */
export interface InvoicePageCursor {
  createdAt: number;
  id: string;
}

export interface InvoiceRepository {
  create(invoice: StoredInvoice): Promise<void>;
  findById(id: string): Promise<StoredInvoice | null>;
  /** Applies the patch and bumps `updatedAt`; returns the updated invoice, or null if unknown. */
  update(id: string, patch: StoredInvoicePatch, now?: number): Promise<StoredInvoice | null>;
  /**
   * Applies the patch only while the invoice is in `from`, as one statement.
   * Returns false, and changes nothing, when it is in another state: of two
   * requests that both try to move the same invoice, exactly one wins.
   */
  transition(id: string, from: InvoiceState, patch: StoredInvoicePatch, now?: number): Promise<boolean>;
  /** Deletes the invoice only while it is a draft. Returns false when it is not, or is unknown. */
  deleteDraft(id: string): Promise<boolean>;
  /** A seller's invoices, newest first. */
  listBySeller(sellerId: string, opts: { limit: number; before?: InvoicePageCursor }): Promise<StoredInvoice[]>;
  /** How many invoices the seller has issued a number for. */
  countNumbered(sellerId: string): Promise<number>;
}

function toRow(r: typeof invoices.$inferSelect): StoredInvoice {
  return {
    id: r.id,
    sellerId: r.sellerId,
    number: r.number,
    linkId: r.linkId,
    clientName: r.clientName,
    clientEmailEncrypted: r.clientEmailEncrypted,
    clientAddressEncrypted: r.clientAddressEncrypted,
    notes: r.notes,
    assetCode: r.assetCode as StoredInvoice["assetCode"],
    lineItems: JSON.parse(r.lineItems) as InvoiceLineItem[],
    total: r.total,
    issuedAt: r.issuedAt,
    dueAt: r.dueAt,
    state: r.state as InvoiceState,
    overdueNotifiedAt: r.overdueNotifiedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toColumns(patch: StoredInvoicePatch): Partial<typeof invoices.$inferInsert> {
  const { lineItems, ...rest } = patch;
  return { ...rest, ...(lineItems === undefined ? {} : { lineItems: JSON.stringify(lineItems) }) };
}

export class DrizzleInvoiceRepository implements InvoiceRepository {
  constructor(private readonly db: DB) {}

  async create(invoice: StoredInvoice): Promise<void> {
    await this.db.insert(invoices).values({ ...invoice, lineItems: JSON.stringify(invoice.lineItems) });
  }

  async findById(id: string): Promise<StoredInvoice | null> {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return row ? toRow(row) : null;
  }

  async update(id: string, patch: StoredInvoicePatch, now = Date.now()): Promise<StoredInvoice | null> {
    await this.db
      .update(invoices)
      .set({ ...toColumns(patch), updatedAt: now })
      .where(eq(invoices.id, id));
    return this.findById(id);
  }

  async transition(id: string, from: InvoiceState, patch: StoredInvoicePatch, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .update(invoices)
      .set({ ...toColumns(patch), updatedAt: now })
      .where(and(eq(invoices.id, id), eq(invoices.state, from)));
    return result.rowsAffected === 1;
  }

  async deleteDraft(id: string): Promise<boolean> {
    const result = await this.db.delete(invoices).where(and(eq(invoices.id, id), eq(invoices.state, "draft")));
    return result.rowsAffected === 1;
  }

  async listBySeller(sellerId: string, opts: { limit: number; before?: InvoicePageCursor }): Promise<StoredInvoice[]> {
    const before = opts.before;
    const rows = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.sellerId, sellerId),
          before
            ? or(
                lt(invoices.createdAt, before.createdAt),
                and(eq(invoices.createdAt, before.createdAt), lt(invoices.id, before.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(opts.limit);
    return rows.map(toRow);
  }

  async countNumbered(sellerId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(invoices)
      .where(and(eq(invoices.sellerId, sellerId), sql`${invoices.number} IS NOT NULL`));
    return Number(row?.n ?? 0);
  }
}
