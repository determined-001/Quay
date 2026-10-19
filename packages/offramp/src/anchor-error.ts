/**
 * A non-2xx answer from an anchor's SEP endpoint.
 *
 * The anchor's response body is third-party content of any size and shape: an
 * HTML error page, a stack trace, internal hostnames, or text that echoes what
 * we sent (including the seller's own KYC or bank fields). It is therefore kept
 * out of `message` and held separately in `body`, truncated, for server-side
 * logs only. Nothing that builds an HTTP response should ever read `body`;
 * use {@link anchorErrorSummary} for text that is safe to show a client.
 */

/** How much of an anchor's response body is retained on the error. */
export const ANCHOR_ERROR_BODY_MAX_BYTES = 2048;

export type AnchorSep = "1" | "6" | "10" | "12" | "24" | "38";

export class AnchorHttpError extends Error {
  readonly sep: AnchorSep;
  readonly op: string;
  readonly status: number;
  /** Truncated anchor response body. Log it; never return it to a client. */
  readonly body: string;

  constructor(input: { sep: AnchorSep; op: string; status: number; body: string }) {
    // The message carries only what we know ourselves: which call, and the
    // HTTP status. It is safe to log and to compare in tests.
    super(`SEP-${input.sep} ${input.op} failed: ${input.status}`);
    this.name = "AnchorHttpError";
    this.sep = input.sep;
    this.op = input.op;
    this.status = input.status;
    this.body = truncateAnchorBody(input.body);
  }
}

import { OffRampRejectedError } from "@checkout/core";

/**
 * An anchor's 4xx refusal of a request (400, 403, 404, 422).
 *
 * This indicates a client or request rejection on its merits (e.g., unsupported pair,
 * KYC required, customer info needed), NOT an anchor outage or infrastructure failure.
 * Extends `OffRampRejectedError` so `CircuitBreakerOffRamp` exempts it and records
 * `status: "rejected"`, and the API returns 422 `offramp_rejected`.
 */
export class AnchorRejectedError extends OffRampRejectedError {
  readonly sep: AnchorSep;
  readonly op: string;
  readonly status: number;
  /** Truncated raw response body for server logs. */
  readonly body: string;
  /** Parsed anchor rejection type or code, when present in a JSON response. */
  readonly rejectionType?: string;
  /** Parsed missing or required fields, when present (e.g. SEP-6 non_interactive_customer_info_needed). */
  readonly fields?: string[];

  constructor(input: {
    sep: AnchorSep;
    op: string;
    status: number;
    body: string;
    message?: string;
    rejectionType?: string;
    fields?: string[];
  }) {
    const summary = input.message ?? `The anchor rejected the request (SEP-${input.sep} ${input.op}, HTTP ${input.status}).`;
    super(summary);
    this.name = "AnchorRejectedError";
    this.sep = input.sep;
    this.op = input.op;
    this.status = input.status;
    this.body = truncateAnchorBody(input.body);
    this.rejectionType = input.rejectionType;
    this.fields = input.fields;
  }
}

/** 4xx statuses that represent request rejections rather than outages. */
export const ANCHOR_REJECTION_STATUSES = new Set([400, 403, 404, 422]);

/**
 * Checks if an HTTP status represents a client/request rejection (400, 403, 404, 422).
 * Note: 429 (rate limiting), 5xx, timeouts and network failures are NOT rejections.
 */
export function isAnchorRejectionStatus(status: number): boolean {
  return ANCHOR_REJECTION_STATUSES.has(status);
}

/** Parses safe details from a JSON rejection body without leaking un-sanitized third party content. */
export function parseAnchorRejection(body: string): { message?: string; rejectionType?: string; fields?: string[] } {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return {};
    const rejectionType = typeof parsed.type === "string" ? parsed.type : undefined;
    const errorStr = typeof parsed.error === "string" ? parsed.error : undefined;
    const fields = Array.isArray(parsed.fields) ? parsed.fields.filter((f: unknown) => typeof f === "string") : undefined;
    return {
      message: errorStr,
      rejectionType,
      fields,
    };
  } catch {
    return {};
  }
}

/** Cuts `body` to {@link ANCHOR_ERROR_BODY_MAX_BYTES} bytes (UTF-8), marking the cut. */
export function truncateAnchorBody(body: string, maxBytes: number = ANCHOR_ERROR_BODY_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= maxBytes) return body;
  // `fatal: false` drops a multi-byte sequence cut in half rather than throwing.
  return `${new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)).replace(/\uFFFD+$/, "")}…[truncated]`;
}

/**
 * Builds an {@link AnchorHttpError} (or {@link AnchorRejectedError} for 400/403/404/422 rejections)
 * from a failed `fetch` response, reading (and bounding) its body.
 * A body that cannot be read becomes an empty string.
 */
export async function anchorHttpError(
  sep: AnchorSep,
  op: string,
  res: Response,
  options: { allowRejection?: boolean } = {},
): Promise<AnchorHttpError | AnchorRejectedError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  if (options.allowRejection && isAnchorRejectionStatus(res.status)) {
    const details = parseAnchorRejection(body);
    const message = details.message
      ? `The anchor rejected the request: ${details.message}`
      : `The anchor rejected the request (SEP-${sep} ${op}, HTTP ${res.status}).`;
    return new AnchorRejectedError({
      sep,
      op,
      status: res.status,
      body,
      message,
      rejectionType: details.rejectionType,
      fields: details.fields,
    });
  }
  return new AnchorHttpError({ sep, op, status: res.status, body });
}

/** Client-safe one-line description, e.g. "The anchor returned an error (SEP-6 withdraw, HTTP 400)." */
export function anchorErrorSummary(err: AnchorHttpError): string {
  return `The anchor returned an error (SEP-${err.sep} ${err.op}, HTTP ${err.status}).`;
}

