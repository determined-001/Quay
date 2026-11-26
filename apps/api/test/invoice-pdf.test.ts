import { describe, expect, it } from "vitest";
import { TESTNET_NOTICE, paymentStatement, renderInvoicePdf, type InvoicePdfView } from "../src/services/invoice-pdf";

// Issue 4.69 (#561): an issued invoice as a PDF.

const DAY = 24 * 60 * 60 * 1000;
const ISSUED = Date.UTC(2026, 10, 26, 9, 30);

function view(over: Partial<InvoicePdfView> = {}): InvoicePdfView {
  return {
    number: "INV-0001",
    sellerName: "Quay Ceramics",
    clientName: "Ada Obi",
    clientAddress: "12 Marina Road, Lagos",
    lineItems: [
      { description: "Design work", quantity: 3, unitPrice: "0.1000001" },
      { description: "Hosting", quantity: 1, unitPrice: "30" },
    ],
    total: "30.3000003",
    assetCode: "USDC",
    issuedAt: ISSUED,
    dueAt: ISSUED + 14 * DAY,
    status: "open",
    payUrl: "https://quay.example/pay/lnk_abc123",
    network: "public",
    ...over,
  };
}

/**
 * The text drawn in an uncompressed PDF, in drawing order. pdfkit writes each
 * run as a `[<hex> kerning <hex> ...] TJ` array; the hex strings are the
 * characters, and joining them drops the kerning numbers between.
 */
function pdfText(pdf: Buffer): string {
  const body = pdf.toString("latin1");
  const runs: string[] = [];
  for (const array of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let run = "";
    for (const hex of array[1]!.matchAll(/<([0-9a-fA-F]*)>/g)) run += Buffer.from(hex[1]!, "hex").toString("latin1");
    runs.push(run);
  }
  return runs.join("\n");
}

const render = async (over: Partial<InvoicePdfView> = {}) => pdfText(await renderInvoicePdf(view(over), { compress: false }));

describe("renderInvoicePdf", () => {
  it("returns a PDF: it starts with %PDF- and ends with %%EOF", async () => {
    const pdf = await renderInvoicePdf(view());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-8).toString("latin1")).toContain("%%EOF");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("contains the invoice number, the total and the client's name and address", async () => {
    const text = await render();
    expect(text).toContain("Invoice INV-0001");
    expect(text).toContain("Total: 30.3000003 USDC");
    expect(text).toContain("Ada Obi");
    expect(text).toContain("12 Marina Road, Lagos");
    expect(text).toContain("From: Quay Ceramics");
  });

  it("prints the dates in UTC and each line with its exact amount", async () => {
    const text = await render();
    expect(text).toContain("Issued: 2026-11-26");
    expect(text).toContain("Due: 2026-12-10");
    const lines = text.split("\n");
    // Description, quantity, unit price, amount, in that order.
    const at = lines.indexOf("Design work");
    expect(lines.slice(at, at + 4)).toEqual(["Design work", "3", "0.1000001", "0.3000003"]);
    const hosting = lines.indexOf("Hosting");
    expect(lines.slice(hosting, hosting + 4)).toEqual(["Hosting", "1", "30", "30"]);
  });

  it("prints amounts from their strings, with every digit a float would lose", async () => {
    const text = await render({
      lineItems: [{ description: "Bulk", quantity: 100000, unitPrice: "9007199.2547409" }],
      total: "900719925474.09",
    });
    expect(text).toContain("9007199.2547409");
    expect(text).toContain("900719925474.09");
    expect(text).toContain("Total: 900719925474.09 USDC");
  });

  it.each([
    ["open", "NOT PAID - due 2026-12-10"],
    ["overdue", "NOT PAID - overdue, was due 2026-12-10"],
    ["paid", "PAID"],
    ["void", "VOID - this invoice was cancelled and must not be paid"],
  ] as const)("says plainly that a %s invoice is %s", async (status, statement) => {
    const text = await render({ status });
    expect(text.split("\n")).toContain(statement);
    expect(paymentStatement({ status, dueAt: ISSUED + 14 * DAY })).toBe(statement);
  });

  it("gives the pay URL while the invoice can be paid, and not once it is paid or void", async () => {
    expect(await render({ status: "open" })).toContain("https://quay.example/pay/lnk_abc123");
    expect(await render({ status: "overdue" })).toContain("https://quay.example/pay/lnk_abc123");
    expect(await render({ status: "paid" })).not.toContain("https://quay.example/pay/lnk_abc123");
    expect(await render({ status: "void" })).not.toContain("https://quay.example/pay/lnk_abc123");
  });

  it("marks a testnet invoice as testnet, at the top and by the asset", async () => {
    const text = await render({ network: "testnet" });
    const lines = text.split("\n");
    expect(lines[0]).toBe(TESTNET_NOTICE);
    expect(lines.filter((l) => l === TESTNET_NOTICE)).toHaveLength(2);
    expect(text).toContain("Payable in USDC on the Stellar test network.");
  });

  it("does not mark a mainnet invoice as testnet, and names the asset and the network", async () => {
    const text = await render({ network: "public", assetCode: "XLM", total: "5" });
    expect(text).not.toContain("TESTNET");
    expect(text).toContain("Payable in XLM on the Stellar public network.");
    expect(text).toContain("Total: 5 XLM");
  });

  it("leaves the address out when the client has none", async () => {
    const lines = (await render({ clientAddress: null })).split("\n");
    const at = lines.indexOf("Bill to");
    expect(lines[at + 1]).toBe("Ada Obi");
    expect(lines[at + 2]).toBe("Description");
  });

  it("renders fifty lines over more than one page, with every line and the total", async () => {
    const lineItems = Array.from({ length: 50 }, (_, i) => ({
      description: `Item number ${i + 1} with a description long enough to wrap onto a second line of the column`,
      quantity: i + 1,
      unitPrice: "1.5",
    }));
    const pdf = await renderInvoicePdf(view({ lineItems, total: "1912.5" }), { compress: false });
    const text = pdfText(pdf);
    expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);
    for (const n of [1, 25, 50]) expect(text).toContain(`Item number ${n} with`);
    expect(text).toContain("Total: 1912.5 USDC");
    // The column header is repeated on the next page.
    expect(text.split("\n").filter((l) => l === "Description").length).toBeGreaterThan(1);
  });

  it("gives the same bytes for the same invoice", async () => {
    const [a, b] = await Promise.all([renderInvoicePdf(view()), renderInvoicePdf(view())]);
    expect(a.equals(b)).toBe(true);
  });

  it("compresses by default: the text is not readable in the raw file", async () => {
    const compressed = await renderInvoicePdf(view());
    const plain = await renderInvoicePdf(view(), { compress: false });
    expect(pdfText(compressed)).not.toContain("INV-0001");
    expect(compressed.length).toBeLessThan(plain.length);
  });
});
