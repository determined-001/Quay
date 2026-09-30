// SEP-9 prefill allowlist (issue 3.17).
//
// SEP-24 lets the wallet put SEP-9 KYC fields in the body of
// POST /transactions/withdraw/interactive so the anchor can pre-populate its
// own hosted form instead of asking the seller to type everything again. That
// is only a good idea under two conditions, and this file exists to enforce both:
//
//   1. The seller agreed to it, per anchor. "I let one cash-out provider
//      pre-fill my form" is not "let every future anchor have my identity",
//      so the field list has to be intersected with a per-(seller, anchor)
//      consent record. With no consent record the answer is nothing, and
//      `pickPrefill` returns `{}` — the anchor's own form is still there, and
//      the seller just types into it as before.
//   2. Only names we have decided to send. A positive allowlist, never a
//      negative blocklist, so a field nobody thought about is dropped by
//      default rather than shipped by accident.
//
// Two classes of field are structurally excluded, and stay excluded even if
// somebody adds them to the list below:
//   - binary documents (`photo_id_front`, `photo_id_back`, …). They are
//     file uploads, not prefill strings, and a base64 ID image in a JSON body
//     is both useless to a form and a serious thing to hand a third party.
//   - `id_number`. It is the single most reusable identity attribute in the
//     whole set and the one an anchor has least need of to pre-fill a form it
//     will validate anyway.
// Organization/business SEP-9 fields are out of scope for this issue; they are
// not in the list, so they are dropped like anything else unlisted.

/** The natural-person SEP-9 fields Quay is willing to pre-fill. */
export const PREFILL_ALLOWED_FIELDS = [
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
] as const;

export type PrefillField = (typeof PREFILL_ALLOWED_FIELDS)[number];

const ALLOWED: ReadonlySet<string> = new Set<string>(PREFILL_ALLOWED_FIELDS);

/** Field names that are never pre-filled, whatever the allowlist says. */
const NEVER_PREFILL: ReadonlySet<string> = new Set(["id_number"]);
const NEVER_PREFILL_PREFIXES: readonly string[] = ["photo_id", "id_document", "document_"];

/**
 * True when `name` may be sent to an anchor as a prefill field — i.e. it is on
 * the allowlist and is not a name this module refuses regardless.
 */
export function isPrefillField(name: string): boolean {
  if (!ALLOWED.has(name)) return false;
  if (NEVER_PREFILL.has(name)) return false;
  return !NEVER_PREFILL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The prefill to send for one anchor, given what is on file and what the seller
 * consented to share. Both inputs are required to agree: a field is included
 * only when it is on the allowlist AND the seller named it in their consent
 * record AND we actually hold a non-empty value for it.
 *
 * Order of the result is the allowlist's, not the caller's, so the request
 * body is stable across runs. Unknown or revoked consent entries are ignored
 * rather than an error: consent can only ever narrow what is sent.
 */
export function pickPrefill(
  provided: Record<string, string>,
  consented: readonly string[],
): Record<string, string> {
  const agreed = new Set(consented);
  const prefill: Record<string, string> = {};
  for (const field of PREFILL_ALLOWED_FIELDS) {
    if (!agreed.has(field)) continue;
    const value = provided[field];
    if (typeof value !== "string" || value === "") continue;
    prefill[field] = value;
  }
  return prefill;
}

/**
 * Allowlisted field names we actually hold a value for — what the seller is
 * offered as a choice in the consent UI. Same filter as `pickPrefill` with
 * nothing consented yet, so the UI can never offer something the request path
 * would then drop.
 */
export function prefillableFieldNames(provided: Record<string, string>): string[] {
  return PREFILL_ALLOWED_FIELDS.filter((field) => {
    const value = provided[field];
    return typeof value === "string" && value !== "";
  });
}
