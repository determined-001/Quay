import { describe, expect, it } from "vitest";
import { isPrefillField, pickPrefill, prefillableFieldNames, PREFILL_ALLOWED_FIELDS } from "../src/sep9";

/**
 * Issue 3.17 — SEP-9 prefill allowlist.
 *
 * The rule under test is narrow on purpose: a field leaves this module only if
 * it is on the allowlist AND the seller named it in their consent AND Quay holds
 * a value for it. Everything else — a payout field someone threaded through by
 * mistake, an id number, a binary document, a key nobody has heard of — is
 * dropped rather than forwarded.
 */
describe("SEP-9 prefill allowlist", () => {
  it("allows exactly the documented natural-person fields", () => {
    expect([...PREFILL_ALLOWED_FIELDS]).toEqual([
      "first_name",
      "last_name",
      "email_address",
      "mobile_number",
      "address",
      "city",
      "state_or_province",
      "postal_code",
      "address_country_code",
      "birth_date",
      "bank_account_number",
      "bank_number",
      "bank_branch_number",
    ]);
  });

  it("never allows id_number or binary documents, even if the list grows", () => {
    // Both are the two things a form can re-ask for, and the two most reusable
    // pieces of identity in the set. isPrefillField refuses them explicitly so a
    // future edit to the allowlist cannot quietly add them.
    expect(isPrefillField("id_number")).toBe(false);
    expect(isPrefillField("photo_id_front")).toBe(false);
    expect(isPrefillField("photo_id_back")).toBe(false);
    expect(isPrefillField("id_document_front")).toBe(false);
  });

  it("is a positive allowlist: unlisted names are refused", () => {
    expect(isPrefillField("dest")).toBe(false);
    expect(isPrefillField("account_number")).toBe(false);
    expect(isPrefillField("company_name")).toBe(false);
    expect(isPrefillField("first_name ")).toBe(false);
  });
});

describe("pickPrefill", () => {
  const provided = {
    first_name: "Ada",
    last_name: "Lovelace",
    email_address: "ada@example.com",
    // Payout details that must never be confused with identity.
    dest: "0123456789",
    account_number: "9999999999",
    id_number: "P1234567",
    photo_id_front: "data:image/png;base64,AAAA",
    city: "",
  };

  it("returns nothing when the seller consented to nothing", () => {
    expect(pickPrefill(provided, [])).toEqual({});
  });

  it("sends exactly the consented fields that are on file", () => {
    expect(pickPrefill(provided, ["first_name"])).toEqual({ first_name: "Ada" });
  });

  it("ignores consent for a field we hold no value for", () => {
    // city is allowlisted and consented, but the stored value is empty.
    expect(pickPrefill(provided, ["city"])).toEqual({});
  });

  it("never copies a payout field, an id number or a binary document", () => {
    const result = pickPrefill(
      provided,
      // Consent for everything, including names that must never be sent.
      [...PREFILL_ALLOWED_FIELDS, "dest", "account_number", "id_number", "photo_id_front"],
    );

    expect(result).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.com",
    });
    expect(result).not.toHaveProperty("dest");
    expect(result).not.toHaveProperty("account_number");
    expect(result).not.toHaveProperty("id_number");
    expect(result).not.toHaveProperty("photo_id_front");
  });

  it("returns keys in allowlist order regardless of the consent order", () => {
    const result = pickPrefill(provided, ["email_address", "first_name"]);
    expect(Object.keys(result)).toEqual(["first_name", "email_address"]);
  });
});

describe("prefillableFieldNames", () => {
  it("lists only allowlisted names we hold a value for", () => {
    expect(
      prefillableFieldNames({ first_name: "Ada", dest: "0123", id_number: "P1", city: "" })
    ).toEqual(["first_name"]);
  });

  it("agrees with pickPrefill, so the UI can never offer a field the request would drop", () => {
    const provided = { first_name: "Ada", last_name: "Lovelace", dest: "0123" };
    for (const name of prefillableFieldNames(provided)) {
      expect(pickPrefill(provided, [name])).toHaveProperty(name);
    }
  });
});
