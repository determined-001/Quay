import type { KycFieldSpec, KycStatus, ProvidedFieldStatus } from "@checkout/core";
import { endpointUrl } from "./sep1";
import { AnchorConfigError, anchorHttpError, type AnchorHttpError } from "./anchor-error";
import { anchorFetch } from "./http";

const FILE_UPLOAD_TIMEOUT_MS = 60_000;

// SEP-12: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
//
// Every field submitted here is a real person's PII (name, email, address, ...).
// This module never fabricates a value — the anchor's discovery response is the
// only source of truth for what's required, and callers decide what to send.

interface RawFieldSpec {
  type: string;
  description?: string;
  optional?: boolean;
  choices?: string[];
}

interface RawProvidedField {
  status?: string;
  error?: string;
}

interface RawGetCustomerResponse {
  id?: string;
  status: string;
  fields?: Record<string, RawFieldSpec>;
  provided_fields?: Record<string, RawProvidedField>;
  message?: string;
}

export interface Sep12CustomerResult {
  customerId: string | null;
  status: KycStatus;
  requiredFields: KycFieldSpec[];
  providedFieldStatus: ProvidedFieldStatus[];
  message: string | null;
  staleCustomerId?: boolean;
}

export function toFieldSpecs(fields: Record<string, RawFieldSpec> | undefined): KycFieldSpec[] {
  if (!fields) return [];
  return Object.entries(fields).map(([name, spec]) => ({
    name,
    type: spec.type,
    description: spec.description,
    optional: spec.optional ?? false,
    choices: spec.choices,
  }));
}

export function toProvidedFieldStatus(fields: Record<string, RawProvidedField> | undefined): ProvidedFieldStatus[] {
  if (!fields) return [];
  return Object.entries(fields).map(([name, spec]) => ({
    name,
    status: spec.status ?? null,
    error: spec.error ?? null,
  }));
}

export function toKycStatus(status: string): KycStatus {
  // ACCEPTED / REJECTED / NEEDS_INFO / PROCESSING are the SEP-12 statuses we
  // model; anything else (e.g. NEEDS_VERIFICATION) is treated as PROCESSING —
  // still not cleared to cash out, but not a hard rejection either.
  if (status === "ACCEPTED" || status === "REJECTED" || status === "NEEDS_INFO" || status === "PROCESSING") {
    return status;
  }
  console.warn(JSON.stringify({ event: "kyc.status.unknown", status }));
  return "PROCESSING";
}

/**
 * An anchor that does not know the `type` we sent answers
 * `400 {"error": "unrecognized 'type' value. see valid values in the /info response"}`.
 * That is the operator's configuration, not a transient anchor failure, so it
 * becomes an {@link AnchorConfigError}; any other failure stays as is.
 */
function sep12Failure(err: AnchorHttpError, type: string | undefined): AnchorHttpError | AnchorConfigError {
  if (type && err.status === 400 && mentionsType(err.body)) return new AnchorConfigError("sep12_type", type);
  return err;
}

function mentionsType(body: string): boolean {
  let text = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const message = (parsed as { error?: unknown }).error;
      text = typeof message === "string" ? message : "";
    }
  } catch {
    // Not JSON: look at the raw text.
  }
  return /\btype\b/i.test(text);
}

/** Discovers required fields and current status for a customer, identified by
 *  `kycServer` is the SEP-1 `KYC_SERVER`; paths are joined onto it, not over it.
 *  If looking up by `customerId` returns 404 (stale ID), retries once by `account`. */
export async function getSep12Customer(
  kycServer: string,
  jwt: string,
  params: { account: string; customerId?: string | null; type?: string },
): Promise<Sep12CustomerResult> {
  const fetchCustomer = (searchKey: "id" | "account", searchValue: string) => {
    const url = endpointUrl(kycServer, "customer");
    url.searchParams.set(searchKey, searchValue);
    if (params.type) url.searchParams.set("type", params.type);
    return anchorFetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  };

  let res: Response;
  let usedAccountFallback = false;
  if (params.customerId) {
    res = await fetchCustomer("id", params.customerId);
    if (res.status === 404) {
      res = await fetchCustomer("account", params.account);
      usedAccountFallback = true;
    }
  } else {
    res = await fetchCustomer("account", params.account);
  }

  if (res.status === 404) {
    // The anchor has no customer for this account (a stale id was already retried by account).
    // `staleCustomerId` tells the caller the stored id was dead.
    return {
      customerId: null,
      status: "unsubmitted",
      requiredFields: [],
      providedFieldStatus: [],
      message: null,
      ...(usedAccountFallback ? { staleCustomerId: true } : {}),
    };
  }
  if (!res.ok) {
    throw sep12Failure(await anchorHttpError("12", "customer GET", res), params.type);
  }
  const body = (await res.json()) as RawGetCustomerResponse;
  return {
    customerId: body.id ?? (usedAccountFallback ? null : params.customerId) ?? null,
    status: toKycStatus(body.status),
    requiredFields: toFieldSpecs(body.fields),
    providedFieldStatus: toProvidedFieldStatus(body.provided_fields),
    message: body.message ?? null,
    ...(usedAccountFallback ? { staleCustomerId: true } : {}),
  };
}

/** Submits exactly the fields given — no defaults, no fabricated identity. */
export async function putSep12Customer(
  kycServer: string,
  jwt: string,
  params: { account: string; customerId?: string | null; fields: Record<string, string>; type?: string },
): Promise<{ customerId: string }> {
  const res = await anchorFetch(endpointUrl(kycServer, "customer"), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      ...(params.customerId ? { id: params.customerId } : { account: params.account }),
      ...params.fields,
      // After the fields: a stray "type" field must not override the configured one.
      ...(params.type ? { type: params.type } : {}),
    }),
  });
  if (!res.ok) {
    throw sep12Failure(await anchorHttpError("12", "customer PUT", res), params.type);
  }
  const body = (await res.json()) as { id: string };
  return { customerId: body.id };
}

/**
 * Registers a callback URL with the anchor for asynchronous SEP-12 status push updates.
 * (SEP-12: PUT [KYC_SERVER]/customer/callback)
 */
export async function putSep12Callback(
  kycServer: string,
  jwt: string,
  params: { customerId?: string | null; url: string },
): Promise<void> {
  const res = await anchorFetch(endpointUrl(kycServer, "customer/callback"), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      url: params.url,
      ...(params.customerId ? { id: params.customerId } : {}),
    }),
  });
  if (!res.ok) {
    throw await anchorHttpError("12", "customer callback PUT", res);
  }
}

/** Ask one anchor to erase the authenticated seller's SEP-12 customer data. */
export async function deleteSep12Customer(kycServer: string, jwt: string, account: string): Promise<"deleted" | "not_found"> {
  const res = await anchorFetch(endpointUrl(kycServer, `customer/${encodeURIComponent(account)}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (res.status === 404) return "not_found";
  if (!res.ok) throw new Error(`SEP-12 customer DELETE failed: ${res.status}`);
  return "deleted";
}

export interface Sep12FileField {
  name: string;
  blob: Blob;
  filename: string;
}

/**
 * Submits multipart/form-data with non-binary fields first, followed by binary
 * file fields, exactly as specified in SEP-12.
 */
export async function putSep12CustomerMultipart(
  kycServer: string,
  jwt: string,
  params: {
    account: string;
    customerId?: string | null;
    fields?: Record<string, string>;
    files: Sep12FileField[];
    type?: string;
  },
): Promise<{ customerId: string }> {
  const formData = new FormData();
  if (params.customerId) {
    formData.append("id", params.customerId);
  } else {
    formData.append("account", params.account);
  }
  if (params.fields) {
    for (const [key, value] of Object.entries(params.fields)) {
      formData.append(key, value);
    }
  }
  if (params.type) formData.set("type", params.type);
  for (const file of params.files) {
    formData.append(file.name, file.blob, file.filename);
  }

  const res = await anchorFetch(endpointUrl(kycServer, "customer"), {
    method: "PUT",
    headers: { authorization: `Bearer ${jwt}` },
    body: formData,
    // Document uploads are larger than the JSON calls, so they get a longer budget.
    timeoutMs: FILE_UPLOAD_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw sep12Failure(await anchorHttpError("12", "customer PUT (files)", res), params.type);
  }
  const body = (await res.json()) as { id: string };
  return { customerId: body.id };
}
