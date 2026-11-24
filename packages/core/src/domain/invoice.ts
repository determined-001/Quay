import type { LinkStatus } from "./status";
import { fromStroops, mulStroops, sumStroops, toStroops, MAX_STROOPS } from "./money";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: string;
}

export type InvoiceState = "draft" | "open" | "void";
export type InvoiceStatus = "draft" | "open" | "paid" | "overdue" | "void";

export interface Invoice {
  id: string;
  sellerId: string;
  number: string | null;
  linkId: string | null;
  clientName: string;
  clientEmail: string | null;
  clientAddress: string | null;
  notes: string | null;
  assetCode: "USDC" | "XLM";
  lineItems: InvoiceLineItem[];
  total: string;
  issuedAt: number | null;
  dueAt: number;
  state: InvoiceState;
  overdueNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Calculates the exact invoice total from line items using fixed-point stroops.
 * No floats are used. Throws if total is 0 or exceeds MAX_STROOPS.
 */
export function invoiceTotal(items: InvoiceLineItem[]): string {
  if (!items || items.length === 0) {
    throw new Error("Invoice must have at least one line item");
  }

  const stroopsList = items.map((item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`Line item quantity must be a positive integer, got ${item.quantity}`);
    }
    const unitPriceStroops = toStroops(item.unitPrice);
    if (unitPriceStroops <= 0n) {
      throw new Error(`Line item unit price must be positive, got ${item.unitPrice}`);
    }
    return mulStroops(unitPriceStroops, item.quantity);
  });

  const total = sumStroops(stroopsList);
  if (total <= 0n) {
    throw new Error("Invoice total must be strictly positive");
  }
  if (total > MAX_STROOPS) {
    throw new Error(`Invoice total exceeds MAX_STROOPS: ${total}`);
  }

  return fromStroops(total);
}

/**
 * Formats a sequential integer into an invoice number (at least 4 digits, grows past 9999).
 * e.g. 1 -> INV-0001, 9999 -> INV-9999, 10000 -> INV-10000.
 */
export function formatInvoiceNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invoice sequence number must be a positive integer, got ${n}`);
  }
  return `INV-${String(n).padStart(4, "0")}`;
}

/**
 * Derives the current effective invoice status from stored state, associated link status,
 * and current timestamp (issue 1.14 / #558).
 *
 * Rules:
 * 1. void wins (if stored state is void, invoice is void)
 * 2. draft stays draft (if stored state is draft, invoice is draft)
 * 3. open state:
 *    - open + link cancelled = void
 *    - open + link in paid/offramp_* = paid
 *    - open + now > dueAt = overdue (including underpaid links past due)
 *    - otherwise open
 */
export function invoiceStatus(
  invoice: Pick<Invoice, "state" | "dueAt">,
  linkStatus: LinkStatus | null,
  now: number,
): InvoiceStatus {
  // 1. void wins
  if (invoice.state === "void") {
    return "void";
  }

  // 2. draft stays draft
  if (invoice.state === "draft") {
    return "draft";
  }

  // 3. open state evaluations
  if (linkStatus === "cancelled") {
    return "void";
  }

  if (
    linkStatus === "paid" ||
    linkStatus === "offramp_pending" ||
    linkStatus === "offramp_settled" ||
    linkStatus === "offramp_failed"
  ) {
    return "paid";
  }

  if (now > invoice.dueAt) {
    return "overdue";
  }

  return "open";
}
