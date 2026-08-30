import { describe, expect, it } from "vitest";
import { csvCell } from "../src/routes/links";

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
