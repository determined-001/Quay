import type { Sep9Field } from "./sep9";
import { ISO3166_ALPHA3_CODES } from "./iso3166-alpha3";

export type Sep9ValidationResult = { ok: true } | { ok: false; reason: string };

const valid: Sep9ValidationResult = { ok: true };
const invalid = (reason: string): Sep9ValidationResult => ({ ok: false, reason });

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 100 && date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Validate text values before storing or submitting them as SEP-9 fields. */
export function validateSep9Value(field: Sep9Field, value: string): Sep9ValidationResult {
  if (field.type === "binary") return invalid("binary fields are not accepted as strings");
  if (value === "") return valid; // optionality belongs to the anchor's SEP-12 request

  if (field.choices && !field.choices.includes(value)) return invalid("unsupported choice");
  if (field.type === "number" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    return invalid("expected a non-negative integer");
  }

  switch (field.encoding) {
    case "iso3166-alpha3":
      return ISO3166_ALPHA3_CODES.has(value) ? valid : invalid("expected an ISO 3166-1 alpha-3 country code");
    case "iso8601-date":
      return isRealIsoDate(value) ? valid : invalid("expected a real YYYY-MM-DD date");
    case "e164":
      return /^\+[1-9]\d{1,14}$/.test(value) ? valid : invalid("expected an E.164 phone number");
    case "iso639-1":
      return /^[a-z]{2}$/.test(value) ? valid : invalid("expected an ISO 639-1 language code");
    case "isco08":
      return /^\d{1,4}$/.test(value) ? valid : invalid("expected a numeric ISCO-08 code");
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? valid : invalid("expected an email address");
    default:
      return valid;
  }
}
