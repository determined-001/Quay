import { describe, it, expect } from "vitest";
import {
  SEP9_NATURAL_PERSON_FIELDS,
  sep9Field,
  SEP9_SENSITIVE_FIELD_NAMES,
  validateSep9Value,
} from "../src/index";

describe("SEP-9 Natural Person Field Catalogue", () => {
  it("contains all expected SEP-9 natural-person fields with unique names", () => {
    expect(SEP9_NATURAL_PERSON_FIELDS.length).toBeGreaterThanOrEqual(30);

    const names = SEP9_NATURAL_PERSON_FIELDS.map((f) => f.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);

    // Verify key fields exist
    expect(names).toContain("first_name");
    expect(names).toContain("last_name");
    expect(names).toContain("birth_date");
    expect(names).toContain("tax_id");
    expect(names).toContain("id_number");
    expect(names).toContain("mobile_number");
    expect(names).toContain("email_address");
    expect(names).toContain("address_country_code");
    expect(names).toContain("photo_id_front");
  });

  it("resolves canonical fields and aliases correctly", () => {
    const lastName = sep9Field("last_name");
    const familyName = sep9Field("family_name");
    expect(lastName).toBeDefined();
    expect(familyName).toBeDefined();
    expect(lastName?.name).toBe("last_name");
    expect(familyName?.name).toBe("last_name");
    expect(lastName).toEqual(familyName);

    const firstName = sep9Field("first_name");
    const givenName = sep9Field("given_name");
    expect(firstName).toBeDefined();
    expect(givenName).toBeDefined();
    expect(firstName?.name).toBe("first_name");
    expect(givenName?.name).toBe("first_name");

    expect(sep9Field("non_existent_field")).toBeUndefined();
  });

  it("exports sensitive field names list including aliases", () => {
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("tax_id");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("id_number");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("first_name");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("given_name");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("last_name");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("family_name");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("birth_date");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("mobile_number");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("email_address");
  });
});

describe("validateSep9Value", () => {
  it("validates ISO 3166-1 alpha-3 country codes", () => {
    const countryField = sep9Field("address_country_code")!;
    expect(validateSep9Value(countryField, "NGA")).toEqual({ ok: true });
    expect(validateSep9Value(countryField, "USA")).toEqual({ ok: true });
    expect(validateSep9Value(countryField, "nga")).toEqual({ ok: true }); // case-insensitive

    const invalid2Letter = validateSep9Value(countryField, "NG");
    expect(invalid2Letter.ok).toBe(false);

    const invalidUnknown = validateSep9Value(countryField, "XYZ");
    expect(invalidUnknown.ok).toBe(false);
  });

  it("validates real calendar ISO-8601 dates", () => {
    const birthDateField = sep9Field("birth_date")!;
    expect(validateSep9Value(birthDateField, "1990-05-15")).toEqual({ ok: true });
    expect(validateSep9Value(birthDateField, "2024-02-29")).toEqual({ ok: true }); // leap year

    expect(validateSep9Value(birthDateField, "2026-02-30").ok).toBe(false); // impossible date
    expect(validateSep9Value(birthDateField, "2025-02-29").ok).toBe(false); // non-leap year
    expect(validateSep9Value(birthDateField, "2026-13-01").ok).toBe(false); // invalid month
    expect(validateSep9Value(birthDateField, "invalid-date").ok).toBe(false);
  });

  it("validates E.164 phone numbers", () => {
    const phoneField = sep9Field("mobile_number")!;
    expect(validateSep9Value(phoneField, "+2348012345678")).toEqual({ ok: true });
    expect(validateSep9Value(phoneField, "+14155552671")).toEqual({ ok: true });

    expect(validateSep9Value(phoneField, "08012345678").ok).toBe(false);
    expect(validateSep9Value(phoneField, "+0123456789").ok).toBe(false);
    expect(validateSep9Value(phoneField, "abc").ok).toBe(false);
  });

  it("validates email addresses", () => {
    const emailField = sep9Field("email_address")!;
    expect(validateSep9Value(emailField, "user@example.com")).toEqual({ ok: true });
    expect(validateSep9Value(emailField, "not-an-email").ok).toBe(false);
  });

  it("validates choice fields", () => {
    const idTypeField = sep9Field("id_type")!;
    expect(validateSep9Value(idTypeField, "passport")).toEqual({ ok: true });
    expect(validateSep9Value(idTypeField, "drivers_license")).toEqual({ ok: true });
    expect(validateSep9Value(idTypeField, "id_card")).toEqual({ ok: true });
    expect(validateSep9Value(idTypeField, "other")).toEqual({ ok: true });
    expect(validateSep9Value(idTypeField, "library_card").ok).toBe(false);

    const sexField = sep9Field("sex")!;
    expect(validateSep9Value(sexField, "female")).toEqual({ ok: true });
    expect(validateSep9Value(sexField, "alien").ok).toBe(false);
  });

  it("rejects string values for binary fields", () => {
    const photoField = sep9Field("photo_id_front")!;
    const res = validateSep9Value(photoField, "binary-content-string");
    expect(res).toEqual({
      ok: false,
      reason: "binary fields are not accepted as strings",
    });
  });

  it("validates ISO 639-1 language codes and ISCO-08 occupation codes", () => {
    const langField = sep9Field("language_code")!;
    expect(validateSep9Value(langField, "en")).toEqual({ ok: true });
    expect(validateSep9Value(langField, "fr")).toEqual({ ok: true });
    expect(validateSep9Value(langField, "english").ok).toBe(false);

    const occupationField = sep9Field("occupation")!;
    expect(validateSep9Value(occupationField, "2512")).toEqual({ ok: true });
    expect(validateSep9Value(occupationField, 2512)).toEqual({ ok: true });
    expect(validateSep9Value(occupationField, "invalid").ok).toBe(false);
  });
});
