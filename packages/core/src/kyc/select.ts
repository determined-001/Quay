import type { KycFieldSpec } from "../ports/index";
import type { Sep9Field } from "./sep9";
import { sep9Field } from "./sep9";

export interface SelectFieldsResult {
  send: Record<string, string>;
  missing: string[];
  unknown: string[];
}

interface Profile {
  fields: Record<string, string>;
}

interface SelectFieldsOptions {
  requested: KycFieldSpec[];
  profile: Profile;
  overrides: Record<string, string>;
}

/**
 * Select which fields to send to an anchor based on what it requested.
 * Only fields the anchor asked for are included in the result.
 * SEP-9 aliases are resolved to the anchor's field name.
 * Unknown (anchor-specific) fields can only come from overrides, never from the profile.
 * Binary fields are excluded (handled separately in 3.13).
 */
export function selectFieldsForAnchor(options: SelectFieldsOptions): SelectFieldsResult {
  const { requested, profile, overrides } = options;
  const send: Record<string, string> = {};
  const missing: string[] = [];
  const unknown: string[] = [];

  for (const field of requested) {
    const sep9 = sep9Field(field.name);

    // Binary fields are never sent via this path (3.13)
    if (sep9?.type === "binary") {
      continue;
    }

    // Check if it's an anchor-specific field (not in SEP-9 catalogue)
    const isSep9 = sep9 !== undefined;

    // Determine the value to send
    let value: string | undefined;

    if (isSep9) {
      // Try to find the value in the profile using the SEP-9 canonical name or its aliases
      for (const name of [field.name, ...(sep9.aliases ?? [])]) {
        if (profile.fields[name] !== undefined) {
          value = profile.fields[name];
          break;
        }
      }
    }

    // Overrides take precedence
    if (overrides[field.name] !== undefined) {
      value = overrides[field.name];
    }

    if (value === undefined || value.trim() === "") {
      if (!field.optional) {
        missing.push(field.name);
      }
    } else {
      send[field.name] = value;
    }

    // Track unknown (anchor-specific) fields
    if (!isSep9) {
      unknown.push(field.name);
    }
  }

  return { send, missing, unknown };
}