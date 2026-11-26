import PDFDocument from "pdfkit";
import { invoiceTotal, type InvoiceLineItem, type InvoiceStatus } from "@checkout/core";

/**
 * What an invoice PDF is drawn from (issue 4.69): the seller's side of an
 * issued invoice, plus where it is paid and which network that is.
 */
export interface InvoicePdfView {
  /** INV-0001. A draft has none and is not rendered. */
  number: string;
  sellerName: string;
  clientName: string;
  clientAddress: string | null;
  lineItems: InvoiceLineItem[];
  /** The total as stored, a decimal string. Printed as is. */
  total: string;
  assetCode: "USDC" | "XLM";
  issuedAt: number;
  dueAt: number;
  status: InvoiceStatus;
  /** `${WEB_URL}/pay/<linkId>`. */
  payUrl: string;
  network: "testnet" | "public";
}

export interface InvoicePdfOptions {
  /**
   * Deflate the page streams. On by default. Tests turn it off so they can
   * read the text back out of the file.
   */
  compress?: boolean;
}

/** The line every testnet invoice carries, so it is never mistaken for a real bill. */
export const TESTNET_NOTICE = "TESTNET - no real money";

const MARGIN = 50;
// The amount columns are wide enough for the largest amount (19 digits and a
// point at 10pt), so a number is never wrapped onto a second line.
const COLUMNS = { description: 50, quantity: 250, unitPrice: 300, amount: 425 } as const;
const WIDTHS = { description: 195, quantity: 45, unitPrice: 120, amount: 120 } as const;

/** `2026-11-26`, in UTC, so the same invoice prints the same date on every server. */
function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Whether it is paid, in words nobody can misread. */
export function paymentStatement(view: Pick<InvoicePdfView, "status" | "dueAt">): string {
  switch (view.status) {
    case "paid":
      return "PAID";
    case "void":
      return "VOID - this invoice was cancelled and must not be paid";
    case "overdue":
      return `NOT PAID - overdue, was due ${isoDate(view.dueAt)}`;
    default:
      return `NOT PAID - due ${isoDate(view.dueAt)}`;
  }
}

/** One line's amount: quantity times unit price, in fixed point. Never through `Number()`. */
function lineAmount(item: InvoiceLineItem): string {
  return invoiceTotal([item]);
}

/**
 * Renders an issued invoice as a PDF (issue 4.69). A pure function of `view`:
 * no clock, no network and no file is read beyond pdfkit's own font metrics,
 * and the document's creation date is the invoice's issue date, so rendering
 * the same invoice twice gives the same bytes.
 *
 * Amounts are printed from their strings. It uses the PDF's built-in
 * Helvetica, which covers Latin text; a character outside it is not drawn.
 */
export function renderInvoicePdf(view: InvoicePdfView, opts: InvoicePdfOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      compress: opts.compress ?? true,
      info: {
        Title: `Invoice ${view.number}`,
        Author: view.sellerName,
        CreationDate: new Date(view.issuedAt),
        ModDate: new Date(view.issuedAt),
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const testnet = view.network === "testnet";
    const right = doc.page.width - MARGIN;
    const bottom = () => doc.page.height - MARGIN;

    if (testnet) {
      doc.font("Helvetica-Bold").fontSize(12).text(TESTNET_NOTICE, MARGIN, MARGIN, { align: "center" });
      doc.moveDown(0.8);
    }

    doc.font("Helvetica-Bold").fontSize(22).text(`Invoice ${view.number}`, MARGIN);
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(12).text(paymentStatement(view));
    doc.moveDown(0.8);

    doc.font("Helvetica").fontSize(10);
    doc.text(`From: ${view.sellerName}`);
    doc.text(`Issued: ${isoDate(view.issuedAt)}`);
    doc.text(`Due: ${isoDate(view.dueAt)}`);
    doc.moveDown(0.8);

    doc.font("Helvetica-Bold").text("Bill to");
    doc.font("Helvetica").text(view.clientName);
    if (view.clientAddress) doc.text(view.clientAddress);
    doc.moveDown(1.2);

    const header = () => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10);
      doc.text("Description", COLUMNS.description, y, { width: WIDTHS.description });
      doc.text("Qty", COLUMNS.quantity, y, { width: WIDTHS.quantity, align: "right" });
      doc.text("Unit price", COLUMNS.unitPrice, y, { width: WIDTHS.unitPrice, align: "right" });
      doc.text("Amount", COLUMNS.amount, y, { width: WIDTHS.amount, align: "right" });
      doc.moveTo(MARGIN, doc.y + 3).lineTo(right, doc.y + 3).stroke();
      doc.y += 9;
      doc.font("Helvetica").fontSize(10);
    };
    header();

    for (const item of view.lineItems) {
      // A long description wraps; start a new page when the row would not fit.
      const height = doc.heightOfString(item.description, { width: WIDTHS.description });
      if (doc.y + height > bottom() - 20) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      doc.text(item.description, COLUMNS.description, y, { width: WIDTHS.description });
      const after = doc.y;
      doc.text(String(item.quantity), COLUMNS.quantity, y, { width: WIDTHS.quantity, align: "right", lineBreak: false });
      doc.text(item.unitPrice, COLUMNS.unitPrice, y, { width: WIDTHS.unitPrice, align: "right", lineBreak: false });
      doc.text(lineAmount(item), COLUMNS.amount, y, { width: WIDTHS.amount, align: "right", lineBreak: false });
      doc.y = Math.max(after, doc.y) + 5;
    }

    if (doc.y > bottom() - 110) doc.addPage();
    doc.moveTo(MARGIN, doc.y + 2).lineTo(right, doc.y + 2).stroke();
    doc.y += 10;
    doc.font("Helvetica-Bold").fontSize(12);
    doc.text(`Total: ${view.total} ${view.assetCode}`, MARGIN, doc.y, { align: "right" });
    doc.moveDown(1.2);

    doc.font("Helvetica").fontSize(10);
    doc.text(
      `Payable in ${view.assetCode} on the Stellar ${testnet ? "test network" : "public network"}.`,
      MARGIN,
      doc.y,
    );
    if (testnet) doc.font("Helvetica-Bold").text(TESTNET_NOTICE).font("Helvetica");
    if (view.status !== "paid" && view.status !== "void") {
      doc.moveDown(0.4);
      doc.text("Pay online:");
      doc.fillColor("#1a4fd6").text(view.payUrl, { link: view.payUrl, underline: true }).fillColor("black");
    }

    doc.end();
  });
}
