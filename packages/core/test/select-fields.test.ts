import { describe, expect, it } from "vitest";
import { selectFieldsForAnchor } from "../src/kyc/select";
import type { KycFieldSpec } from "../src/ports/index";

describe("selectFieldsForAnchor", () => {
  const profile = {
    fields: {
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.org",
      mobile_number: "+15551234567",
      birth_date: "1815-12-10",
      tax_id: "123-45-6789",
      family_name: "Lovelace",
      given_name: "Ada",
    },
  };

  const requested: KycFieldSpec[] = [
    { name: "first_name", type: "string", optional: false },
    { name: "last_name", type: "string", optional: false },
    { name: "email_address", type: "string", optional: true },
    { name: "mobile_number", type: "string", optional: false },
    { name: "birth_date", type: "date", optional: false },
    { name: "tax_id", type: "string", optional: true },
    { name: "custom_field", type: "string", optional: false },
  ];

  it("selects only fields the anchor requested from the profile", () => {
    const result = selectFieldsForAnchor({
      requested,
      profile: { fields: profile.fields },
      overrides: {},
    });

    expect(result.send).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.org",
      mobile_number: "+15551234567",
      birth_date: "1815-12-10",
      tax_id: "123-45-6789",
    });
    expect(result.missing).toEqual(["custom_field"]);
    expect(result.unknown).toEqual(["custom_field"]);
  });

  it("maps SEP-9 aliases: anchor asks for family_name, profile has last_name", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "family_name", type: "string", optional: false }],
      profile: { fields: { last_name: "Lovelace" } },
      overrides: {},
    });

    expect(result.send).toEqual({ family_name: "Lovelace" });
    expect(result.missing).toEqual([]);
  });

  it("maps SEP-9 aliases: anchor asks for given_name, profile has first_name", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "given_name", type: "string", optional: false }],
      profile: { fields: { first_name: "Ada" } },
      overrides: {},
    });

    expect(result.send).toEqual({ given_name: "Ada" });
    expect(result.missing).toEqual([]);
  });

  it("overrides take precedence over profile", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "first_name", type: "string", optional: false }],
      profile: { fields: { first_name: "Ada" } },
      overrides: { first_name: "Charles" },
    });

    expect(result.send).toEqual({ first_name: "Charles" });
  });

  it("unknown (anchor-specific) fields only come from overrides", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "custom_field", type: "string", optional: false }],
      profile: { fields: { custom_field: "from_profile" } },
      overrides: { custom_field: "from_override" },
    });

    expect(result.send).toEqual({ custom_field: "from_override" });
    expect(result.unknown).toEqual(["custom_field"]);
  });

  it("unknown field without override is missing", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "custom_field", type: "string", optional: false }],
      profile: { fields: {} },
      overrides: {},
    });

    expect(result.send).toEqual({});
    expect(result.missing).toEqual(["custom_field"]);
    expect(result.unknown).toEqual(["custom_field"]);
  });

  it("optional unknown field without override is not missing", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "custom_field", type: "string", optional: true }],
      profile: { fields: {} },
      overrides: {},
    });

    expect(result.send).toEqual({});
    expect(result.missing).toEqual([]);
    expect(result.unknown).toEqual(["custom_field"]);
  });

  it("excludes binary fields", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "photo_id_front", type: "binary", optional: false }],
      profile: { fields: { photo_id_front: "base64data" } },
      overrides: {},
    });

    expect(result.send).toEqual({});
    expect(result.missing).toEqual([]);
  });

  it("empty string values are treated as missing for required fields", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "first_name", type: "string", optional: false }],
      profile: { fields: { first_name: "" } },
      overrides: {},
    });

    expect(result.send).toEqual({});
    expect(result.missing).toEqual(["first_name"]);
  });

  it("optional field with empty value is not missing", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "first_name", type: "string", optional: true }],
      profile: { fields: { first_name: "" } },
      overrides: {},
    });

    expect(result.send).toEqual({});
    expect(result.missing).toEqual([]);
  });

  it("profile with 20 fields, anchor asks for 3 -> exactly 3 sent", () => {
    const manyFields: Record<string, string> = {
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.org",
      mobile_number: "+15551234567",
      birth_date: "1815-12-10",
      tax_id: "123-45-6789",
      address_country_code: "USA",
      city: "London",
      postal_code: "SW1A 1AA",
      given_name: "Ada",
      family_name: "Lovelace",
      additional_name: "King",
      state_or_province: "England",
      address: "123 Main St",
      mobile_number_format: "E.164",
      birth_place: "London",
      birth_country_code: "GBR",
      tax_id_name: "UTR",
      occupation: "1234",
    };
    const requested: KycFieldSpec[] = [
      { name: "first_name", type: "string", optional: false },
      { name: "last_name", type: "string", optional: false },
      { name: "email_address", type: "string", optional: false },
    ];

    const result = selectFieldsForAnchor({
      requested,
      profile: { fields: manyFields },
      overrides: {},
    });

    expect(Object.keys(result.send)).toHaveLength(3);
    expect(result.send.first_name).toBe("Ada");
    expect(result.send.last_name).toBe("Lovelace");
    expect(result.send.email_address).toBe("ada@example.org");
  });
});