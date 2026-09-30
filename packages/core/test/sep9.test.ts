import { describe, expect, it } from "vitest";
import {
  fieldsForKind,
  SEP9_NATURAL_PERSON_FIELDS,
  SEP9_ORGANIZATION_FIELDS,
  SEP9_SENSITIVE_FIELD_NAMES,
  sep9Field,
  validateSep9Value,
} from "../src/index";

const ORGANIZATION_NAMES = [
  "organization.name",
  "organization.VAT_number",
  "organization.registration_number",
  "organization.registration_date",
  "organization.registered_address",
  "organization.number_of_shareholders",
  "organization.shareholder_name",
  "organization.photo_incorporation_doc",
  "organization.photo_proof_address",
  "organization.address_country_code",
  "organization.state_or_province",
  "organization.city",
  "organization.postal_code",
  "organization.director_name",
  "organization.website",
  "organization.email",
  "organization.phone",
];

describe("SEP-9 catalogue", () => {
  it("contains every organization field exactly once, with its SEP-9 type and organization group", () => {
    expect(SEP9_ORGANIZATION_FIELDS.map((field) => field.name)).toEqual(ORGANIZATION_NAMES);
    expect(new Set(ORGANIZATION_NAMES).size).toBe(ORGANIZATION_NAMES.length);
    expect(SEP9_ORGANIZATION_FIELDS.every((field) => field.group === "organization" && field.sensitive)).toBe(true);
    expect(sep9Field("organization.registration_date")?.type).toBe("string");
    expect(sep9Field("organization.number_of_shareholders")?.type).toBe("number");
    expect(sep9Field("organization.photo_incorporation_doc")?.type).toBe("binary");
    expect(sep9Field("organization.photo_proof_address")?.type).toBe("binary");
  });

  it("keeps the natural-person fields and resolves aliases and dotted keys literally", () => {
    expect(SEP9_NATURAL_PERSON_FIELDS).toHaveLength(34);
    expect(sep9Field("last_name")).toBe(sep9Field("family_name"));
    expect(sep9Field("first_name")).toBe(sep9Field("given_name"));
    expect(sep9Field("organization.name")?.name).toBe("organization.name");
    expect(sep9Field("name")).toBeUndefined();
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("organization.name");
    expect(SEP9_SENSITIVE_FIELD_NAMES).toContain("tax_id");
  });

  it("returns natural-person fields for individuals and both sets for organizations", () => {
    expect(fieldsForKind("individual")).toEqual(SEP9_NATURAL_PERSON_FIELDS);
    expect(fieldsForKind("individual").some((field) => field.group === "organization")).toBe(false);
    expect(fieldsForKind("organization")).toHaveLength(
      SEP9_NATURAL_PERSON_FIELDS.length + SEP9_ORGANIZATION_FIELDS.length,
    );
    expect(fieldsForKind("organization")).toContain(SEP9_NATURAL_PERSON_FIELDS[0]);
    expect(fieldsForKind("organization")).toContain(SEP9_ORGANIZATION_FIELDS[0]);
  });
});

describe("SEP-9 value validation", () => {
  const validate = (name: string, value: string) => validateSep9Value(sep9Field(name)!, value).ok;

  it("accepts only assigned ISO alpha-3 country codes", () => {
    expect(validate("organization.address_country_code", "NGA")).toBe(true);
    expect(validate("organization.address_country_code", "NG")).toBe(false);
    expect(validate("organization.address_country_code", "ZZZ")).toBe(false);
    expect(validate("organization.address_country_code", "XKS")).toBe(false);
  });

  it("validates organization registration dates as real ISO dates while keeping SEP-9 string type", () => {
    expect(validate("organization.registration_date", "2024-02-29")).toBe(true);
    expect(validate("organization.registration_date", "2026-02-30")).toBe(false);
    expect(validate("organization.registration_date", "24/02/29")).toBe(false);
    expect(validate("organization.registration_date", "")).toBe(true);
  });

  it("uses E.164 for organization contact phones and rejects binary strings", () => {
    expect(validate("organization.phone", "+2348012345678")).toBe(true);
    expect(validate("organization.phone", "08012345678")).toBe(false);
    expect(validate("organization.photo_incorporation_doc", "base64-data")).toBe(false);
    expect(validate("organization.photo_proof_address", "base64-data")).toBe(false);
  });

  it("checks number, email, natural-person date, and choice encodings", () => {
    expect(validate("organization.number_of_shareholders", "3")).toBe(true);
    expect(validate("organization.number_of_shareholders", "3.5")).toBe(false);
    expect(validate("organization.number_of_shareholders", "99999999999999999999")).toBe(false);
    expect(validate("organization.email", "owner@example.com")).toBe(true);
    expect(validate("organization.email", "owner-at-example.com")).toBe(false);
    expect(validate("birth_date", "2026-02-30")).toBe(false);
    expect(validate("birth_date", "0099-01-01")).toBe(false);
    expect(validate("language_code", "en")).toBe(true);
    expect(validate("language_code", "eng")).toBe(false);
    expect(validate("occupation", "1234")).toBe(true);
    expect(validate("occupation", "abc")).toBe(false);
    expect(validate("occupation", "12345")).toBe(false);
    expect(validate("organization.name", "Merchant Ltd")).toBe(true);
    expect(validate("sex", "other")).toBe(true);
    expect(validate("sex", "unknown")).toBe(false);
  });
});
