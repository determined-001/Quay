import type { SellerProfileKind } from "../ports/index";

/** Standard SEP-9 keys. Dots are part of organization keys, not object paths. */
export type Sep9Type = "string" | "date" | "number" | "binary";
export type Sep9Encoding =
  | "iso3166-alpha3"
  | "iso8601-date"
  | "e164"
  | "iso639-1"
  | "isco08"
  | "email"
  | null;

export interface Sep9Field {
  name: string;
  aliases?: readonly string[];
  type: Sep9Type;
  encoding: Sep9Encoding;
  choices?: readonly string[];
  sensitive: boolean;
  label: string;
  group:
    | "name"
    | "contact"
    | "address"
    | "birth"
    | "tax"
    | "id_document"
    | "employment"
    | "other"
    | "organization";
}

function field(
  name: string,
  type: Sep9Type,
  label: string,
  group: Sep9Field["group"],
  encoding: Sep9Encoding = null,
  aliases?: readonly string[],
  choices?: readonly string[],
): Sep9Field {
  return { name, type, encoding, label, group, sensitive: true, ...(aliases && { aliases }), ...(choices && { choices }) };
}

/** Includes each natural-person entry in SEP-9 once; alternate spellings are aliases. */
export const SEP9_NATURAL_PERSON_FIELDS: readonly Sep9Field[] = [
  field("family_name", "string", "Family name", "name", null, ["last_name"]),
  field("given_name", "string", "Given name", "name", null, ["first_name"]),
  field("additional_name", "string", "Additional name", "name"),
  field("address_country_code", "string", "Address country", "address", "iso3166-alpha3"),
  field("state_or_province", "string", "State or province", "address"),
  field("city", "string", "City", "address"),
  field("postal_code", "string", "Postal code", "address"),
  field("address", "string", "Address", "address"),
  field("mobile_number", "string", "Mobile number", "contact", "e164"),
  field("mobile_number_format", "string", "Mobile number format", "contact"),
  field("email_address", "string", "Email address", "contact", "email"),
  field("birth_date", "date", "Date of birth", "birth", "iso8601-date"),
  field("birth_place", "string", "Place of birth", "birth"),
  field("birth_country_code", "string", "Birth country", "birth", "iso3166-alpha3"),
  field("tax_id", "string", "Tax ID", "tax"),
  field("tax_id_name", "string", "Tax ID type", "tax"),
  field("occupation", "number", "Occupation code", "employment", "isco08"),
  field("employer_name", "string", "Employer name", "employment"),
  field("employer_address", "string", "Employer address", "employment"),
  field("language_code", "string", "Language", "other", "iso639-1"),
  field("id_type", "string", "ID type", "id_document"),
  field("id_country_code", "string", "ID country", "id_document", "iso3166-alpha3"),
  field("id_issue_date", "date", "ID issue date", "id_document", "iso8601-date"),
  field("id_expiration_date", "date", "ID expiration date", "id_document", "iso8601-date"),
  field("id_number", "string", "ID number", "id_document"),
  field("photo_id_front", "binary", "ID front image", "id_document"),
  field("photo_id_back", "binary", "ID back image", "id_document"),
  field("notary_approval_of_photo_id", "binary", "Notary approval", "id_document"),
  field("ip_address", "string", "IP address", "other"),
  field("photo_proof_residence", "binary", "Proof of residence", "address"),
  field("sex", "string", "Sex", "other", null, undefined, ["male", "female", "other"]),
  field("proof_of_income", "binary", "Proof of income", "other"),
  field("proof_of_liveness", "binary", "Proof of liveness", "other"),
  field("referral_id", "string", "Referral ID", "other"),
];

export const SEP9_ORGANIZATION_FIELDS: readonly Sep9Field[] = [
  field("organization.name", "string", "Registered organization name", "organization"),
  field("organization.VAT_number", "string", "VAT number", "organization"),
  field("organization.registration_number", "string", "Registration number", "organization"),
  // SEP-9 calls this a string. The encoding still enforces a real date.
  field("organization.registration_date", "string", "Registration date", "organization", "iso8601-date"),
  field("organization.registered_address", "string", "Registered address", "organization"),
  field("organization.number_of_shareholders", "number", "Number of shareholders", "organization"),
  field("organization.shareholder_name", "string", "Shareholder name", "organization"),
  field("organization.photo_incorporation_doc", "binary", "Incorporation document", "organization"),
  field("organization.photo_proof_address", "binary", "Proof of address", "organization"),
  field("organization.address_country_code", "string", "Address country", "organization", "iso3166-alpha3"),
  field("organization.state_or_province", "string", "State or province", "organization"),
  field("organization.city", "string", "City", "organization"),
  field("organization.postal_code", "string", "Postal code", "organization"),
  field("organization.director_name", "string", "Managing director", "organization"),
  field("organization.website", "string", "Website", "organization"),
  field("organization.email", "string", "Contact email", "organization", "email"),
  field("organization.phone", "string", "Contact phone", "organization", "e164"),
];

const ALL_FIELDS = [...SEP9_NATURAL_PERSON_FIELDS, ...SEP9_ORGANIZATION_FIELDS];
const FIELD_BY_NAME = new Map<string, Sep9Field>();
for (const entry of ALL_FIELDS) {
  for (const name of [entry.name, ...(entry.aliases ?? [])]) {
    if (FIELD_BY_NAME.has(name)) throw new Error(`Duplicate SEP-9 field: ${name}`);
    FIELD_BY_NAME.set(name, entry);
  }
}

export function sep9Field(name: string): Sep9Field | undefined {
  return FIELD_BY_NAME.get(name);
}

export function fieldsForKind(kind: SellerProfileKind): readonly Sep9Field[] {
  return kind === "organization" ? ALL_FIELDS : SEP9_NATURAL_PERSON_FIELDS;
}

export const SEP9_SENSITIVE_FIELD_NAMES: readonly string[] = ALL_FIELDS.flatMap((entry) =>
  entry.sensitive ? [entry.name, ...(entry.aliases ?? [])] : [],
);
