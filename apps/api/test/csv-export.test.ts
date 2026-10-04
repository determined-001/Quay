import { describe, expect, it } from "vitest";
import type { PaymentLink } from "@checkout/core";
import { LINKS_CSV_HEADER, csvCell, linkToCsvRow } from "../src/routes/links";

/**
 * Regression, BUG-4.13. `GET /links/export/csv` quoted cells but did not
 * neutralise leading formula characters, so a link title of
 * `=cmd|'/c calc'!A1` was written to the reconciliation export verbatim and
 * evaluated on open by Excel, LibreOffice and Google Sheets.
 */
describe("csvCell — spreadsheet formula injection", () => {
  it("prefixes the four formula-trigger characters with an apostrophe", () => {
    // Only double-quotes are doubled per RFC 4180; apostrophes pass through.
    expect(csvCell("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    expect(csvCell("+1+1")).toBe(`"'+1+1"`);
    expect(csvCell("-2+3")).toBe(`"'-2+3"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
  });

  it("guards leading tab and carriage return, which Excel also treats as formula starts", () => {
    expect(csvCell("\t=1+1")).toBe(`"'\t=1+1"`);
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("leaves ordinary titles untouched apart from RFC 4180 quoting", () => {
    expect(csvCell("T-shirt")).toBe(`"T-shirt"`);
    expect(csvCell('Invoice "1024"')).toBe(`"Invoice ""1024"""`);
    expect(csvCell("")).toBe(`""`);
  });

  it("does not guard a hyphen that is not leading", () => {
    expect(csvCell("Blue T-shirt")).toBe(`"Blue T-shirt"`);
  });
});

describe("links CSV export — cash-out state", () => {
  const link = (over: Partial<PaymentLink> = {}): PaymentLink =>
    ({
      id: "lnk_1",
      reference: "ref1",
      title: "Invoice",
      amount: "10",
      asset: { code: "USDC", issuer: null },
      status: "offramp_pending",
      payer: null,
      txHash: null,
      paidAmount: null,
      createdAt: Date.UTC(2026, 0, 1),
      updatedAt: Date.UTC(2026, 0, 2),
      offrampStatus: null,
      ...over,
    }) as PaymentLink;

  it("adds offramp_status as the LAST column, so earlier columns keep their positions", () => {
    const cols = LINKS_CSV_HEADER.trim().split(",");
    expect(cols.slice(0, 11)).toEqual([
      "id", "reference", "title", "amount", "asset", "status",
      "payer", "tx_hash", "paid_amount", "created_at", "updated_at",
    ]);
    expect(cols.at(-1)).toBe("offramp_status");
  });

  it("tells a cash-out awaiting the seller's transfer from one the anchor is processing", () => {
    const awaiting = linkToCsvRow(link({ offrampStatus: "awaiting_transfer" })).split(",");
    const processing = linkToCsvRow(link({ offrampStatus: "pending" })).split(",");
    // `status` is identical, which is exactly why the extra column exists
    expect(awaiting[5]).toBe("offramp_pending");
    expect(processing[5]).toBe("offramp_pending");
    expect(awaiting.at(-1)).toBe("awaiting_transfer");
    expect(processing.at(-1)).toBe("pending");
  });

  it("leaves offramp_status empty for a link that was never cashed out", () => {
    const row = linkToCsvRow(link({ status: "paid", offrampStatus: null })).split(",");
    expect(row).toHaveLength(LINKS_CSV_HEADER.trim().split(",").length);
    expect(row.at(-1)).toBe("");
  });
});
