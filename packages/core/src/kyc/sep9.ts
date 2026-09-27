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
  name: string; // canonical SEP-9 key, e.g. "birth_date"
  aliases?: string[]; // e.g. last_name <-> family_name
  type: Sep9Type;
  encoding: Sep9Encoding;
  choices?: readonly string[]; // e.g. sex: male|female|other
  sensitive: boolean; // true for every field that identifies a person
  label: string; // human label for forms
  group:
    | "name"
    | "contact"
    | "address"
    | "birth"
    | "tax"
    | "id_document"
    | "employment"
    | "other";
}

export const SEP9_NATURAL_PERSON_FIELDS: readonly Sep9Field[] = [
  // Name
  {
    name: "last_name",
    aliases: ["family_name"],
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Last Name",
    group: "name",
  },
  {
    name: "first_name",
    aliases: ["given_name"],
    type: "string",
    encoding: null,
    sensitive: true,
    label: "First Name",
    group: "name",
  },
  {
    name: "additional_name",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Additional Name / Middle Name",
    group: "name",
  },

  // Address
  {
    name: "address_country_code",
    type: "string",
    encoding: "iso3166-alpha3",
    sensitive: true,
    label: "Address Country Code",
    group: "address",
  },
  {
    name: "state_or_province",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "State or Province",
    group: "address",
  },
  {
    name: "city",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "City",
    group: "address",
  },
  {
    name: "postal_code",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Postal Code",
    group: "address",
  },
  {
    name: "address",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Street Address",
    group: "address",
  },
  {
    name: "photo_proof_residence",
    type: "binary",
    encoding: null,
    sensitive: true,
    label: "Proof of Address Document",
    group: "address",
  },

  // Contact
  {
    name: "mobile_number",
    type: "string",
    encoding: "e164",
    sensitive: true,
    label: "Mobile Number",
    group: "contact",
  },
  {
    name: "mobile_number_format",
    type: "string",
    encoding: null,
    sensitive: false,
    label: "Mobile Number Format",
    group: "contact",
  },
  {
    name: "email_address",
    type: "string",
    encoding: "email",
    sensitive: true,
    label: "Email Address",
    group: "contact",
  },

  // Birth
  {
    name: "birth_date",
    type: "date",
    encoding: "iso8601-date",
    sensitive: true,
    label: "Birth Date",
    group: "birth",
  },
  {
    name: "birth_place",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Birth Place",
    group: "birth",
  },
  {
    name: "birth_country_code",
    type: "string",
    encoding: "iso3166-alpha3",
    sensitive: true,
    label: "Birth Country Code",
    group: "birth",
  },
  {
    name: "sex",
    type: "string",
    encoding: null,
    choices: ["male", "female", "other"],
    sensitive: true,
    label: "Sex",
    group: "birth",
  },

  // Tax
  {
    name: "tax_id",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Tax ID Number",
    group: "tax",
  },
  {
    name: "tax_id_name",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Tax ID Authority / Name",
    group: "tax",
  },

  // Employment
  {
    name: "occupation",
    type: "number",
    encoding: "isco08",
    sensitive: true,
    label: "Occupation (ISCO-08 Code)",
    group: "employment",
  },
  {
    name: "employer_name",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Employer Name",
    group: "employment",
  },
  {
    name: "employer_address",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Employer Address",
    group: "employment",
  },
  {
    name: "proof_of_income",
    type: "binary",
    encoding: null,
    sensitive: true,
    label: "Proof of Income Document",
    group: "employment",
  },

  // ID Document
  {
    name: "id_type",
    type: "string",
    encoding: null,
    choices: ["passport", "drivers_license", "id_card", "other"],
    sensitive: true,
    label: "Identity Document Type",
    group: "id_document",
  },
  {
    name: "id_country_code",
    type: "string",
    encoding: "iso3166-alpha3",
    sensitive: true,
    label: "ID Issuing Country Code",
    group: "id_document",
  },
  {
    name: "id_issue_date",
    type: "date",
    encoding: "iso8601-date",
    sensitive: true,
    label: "ID Issue Date",
    group: "id_document",
  },
  {
    name: "id_expiration_date",
    type: "date",
    encoding: "iso8601-date",
    sensitive: true,
    label: "ID Expiration Date",
    group: "id_document",
  },
  {
    name: "id_number",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "Identity Document Number",
    group: "id_document",
  },
  {
    name: "photo_id_front",
    type: "binary",
    encoding: null,
    sensitive: true,
    label: "Photo ID Front",
    group: "id_document",
  },
  {
    name: "photo_id_back",
    type: "binary",
    encoding: null,
    sensitive: true,
    label: "Photo ID Back",
    group: "id_document",
  },
  {
    name: "notary_approval_of_photo_id",
    type: "binary",
    encoding: null,
    sensitive: true,
    label: "Notary Approval of Photo ID",
    group: "id_document",
  },
  {
    name: "proof_of_liveness",
    type: "binary",
    encoding: null,
    sensitive: true,
    label: "Proof of Liveness Selfie/Video",
    group: "id_document",
  },

  // Other
  {
    name: "language_code",
    type: "string",
    encoding: "iso639-1",
    sensitive: false,
    label: "Preferred Language Code",
    group: "other",
  },
  {
    name: "ip_address",
    type: "string",
    encoding: null,
    sensitive: true,
    label: "IP Address",
    group: "other",
  },
  {
    name: "referral_id",
    type: "string",
    encoding: null,
    sensitive: false,
    label: "Referral ID",
    group: "other",
  },
] as const;

export function sep9Field(name: string): Sep9Field | undefined {
  const normalized = name.trim().toLowerCase();
  return SEP9_NATURAL_PERSON_FIELDS.find(
    (field) =>
      field.name.toLowerCase() === normalized ||
      field.aliases?.some((alias) => alias.toLowerCase() === normalized)
  );
}

export const SEP9_SENSITIVE_FIELD_NAMES: readonly string[] = Array.from(
  new Set(
    SEP9_NATURAL_PERSON_FIELDS.filter((f) => f.sensitive).flatMap((f) => [
      f.name,
      ...(f.aliases ?? []),
    ])
  )
);
