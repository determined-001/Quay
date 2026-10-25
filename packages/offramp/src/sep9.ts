/**
 * SEP-9 fields that may be sent to an anchor to pre-populate its SEP-24
 * interactive form (issue 3.17).
 *
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0009.md
 *
 * This is a ceiling, not a default: a field leaves Quay only if it is in this
 * list AND the seller consented to share it with that anchor AND we hold a
 * value for it. Everything else is dropped.
 *
 * Deliberately absent: binary fields (`photo_id_front`, ...), which are never
 * stored and never forwarded, and `id_number`, a government identifier with no
 * place in a form prefill. Payout/bank details from the cash-out form are not
 * SEP-9 identity and never travel this path.
 *
 * Both spellings of the name fields are listed because they are the same
 * SEP-9 entries (`first_name`/`given_name`, `last_name`/`family_name`) and the
 * anchor chooses which one it asks for.
 */
export const SEP24_PREFILL_FIELDS: readonly string[] = [
  "first_name",
  "last_name",
  "given_name",
  "family_name",
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
];

const ALLOWED: ReadonlySet<string> = new Set(SEP24_PREFILL_FIELDS);

/** Whether `name` may ever be prefilled. */
export function isPrefillField(name: string): boolean {
  return ALLOWED.has(name);
}

/**
 * The values to send: names in `provided` (what Quay holds for the seller)
 * that are on the allowlist AND in `consented`. A blank value is not sent. With
 * an empty `consented` list the result is always empty.
 */
export function pickPrefill(
  provided: Readonly<Record<string, string>>,
  consented: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of consented) {
    if (!ALLOWED.has(name)) continue;
    const value = provided[name];
    if (typeof value === "string" && value.trim() !== "") out[name] = value;
  }
  return out;
}
