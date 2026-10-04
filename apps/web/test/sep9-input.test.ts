import { describe, expect, it } from "vitest";
import { ISO3166_ALPHA3_CODES } from "@checkout/core";
import { checkSep9Value, countryOptions, normalizePhone, sep9InputSpec } from "../lib/sep9-input";

const TODAY = "2026-06-15";

describe("normalizePhone", () => {
  it("turns a local Nigerian number into E.164", () => {
    expect(normalizePhone("0801 234 5678")).toBe("+2348012345678");
    expect(normalizePhone("(0801) 234-5678")).toBe("+2348012345678");
  });
  it("keeps numbers that already carry a country code", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
  });
  it("uses the chosen dial code and leaves empty input empty", () => {
    expect(normalizePhone("0712345678", "+254")).toBe("+254712345678");
    expect(normalizePhone("  ")).toBe("");
  });
});

describe("checkSep9Value", () => {
  it("rejects a 2-letter country with a hint", () => {
    const r = checkSep9Value("address_country_code", "NG", TODAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/alpha-3/);
    expect(checkSep9Value("address_country_code", "NGA", TODAY).ok).toBe(true);
  });
  it("rejects a future birth_date and a non-ISO date", () => {
    expect(checkSep9Value("birth_date", "2030-01-01", TODAY).ok).toBe(false);
    expect(checkSep9Value("birth_date", "04/07/1976", TODAY).ok).toBe(false);
    expect(checkSep9Value("birth_date", "1976-07-04", TODAY).ok).toBe(true);
  });
  it("warns, without blocking, on an expired id", () => {
    const r = checkSep9Value("id_expiration_date", "2020-01-01", TODAY);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/expired/);
  });
  it("validates phone and email through the shared validators", () => {
    expect(checkSep9Value("mobile_number", "0801", TODAY).ok).toBe(false);
    expect(checkSep9Value("mobile_number", "+2348012345678", TODAY).ok).toBe(true);
    expect(checkSep9Value("email_address", "nope", TODAY).ok).toBe(false);
  });
  it("accepts empty values and unknown fields", () => {
    expect(checkSep9Value("birth_date", "", TODAY).ok).toBe(true);
    expect(checkSep9Value("anchor_custom", "anything", TODAY).ok).toBe(true);
  });
});

describe("sep9InputSpec", () => {
  it("maps catalogue encodings to input kinds", () => {
    expect(sep9InputSpec("birth_date").kind).toBe("date");
    expect(sep9InputSpec("id_country_code").kind).toBe("country");
    expect(sep9InputSpec("organization.phone").kind).toBe("phone");
    expect(sep9InputSpec("email_address").kind).toBe("email");
    expect(sep9InputSpec("occupation").kind).toBe("isco");
    expect(sep9InputSpec("birth_date").hint).toMatch(/YYYY-MM-DD/);
  });
  it("renders unknown anchor fields as plain inputs", () => {
    expect(sep9InputSpec("favourite_colour")).toEqual({ kind: "text", field: undefined, hint: null });
  });
});

describe("countryOptions", () => {
  it("covers every alpha-3 code and labels Nigeria", () => {
    const options = countryOptions();
    expect(options).toHaveLength(ISO3166_ALPHA3_CODES.size);
    expect(options.find((o) => o.code === "NGA")?.label).toBe("Nigeria (NGA)");
  });
});
