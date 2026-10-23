/**
 * A non-2xx answer from an anchor's SEP endpoint.
 *
 * The anchor's response body is third-party content of any size and shape: an
 * HTML error page, a stack trace, internal hostnames, or text that echoes what
 * we sent (including the seller's own KYC or bank fields). It is therefore kept
 * out of `message` and held separately in `body`, truncated, for server-side
 * logs only. Nothing that builds an HTTP response should ever read `body`;
 * use {@link anchorErrorSummary} or {@link anchorRejectionSummary} for text
 * that is safe to show a client.
 *
 * A non-2xx is not automatically an outage. {@link anchorCallError} splits the
 * answers that mean "not like this" (a 400/403/404/422 the anchor chose to
 * send) from the ones that mean "I am broken" (5xx, 429), so a single seller
 * asking for a pair the anchor does not support cannot open the circuit for
 * everybody (issue 3.29).
 */

import { OffRampRejectedError } from "@checkout/core";

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

/** Cuts `body` to {@link ANCHOR_ERROR_BODY_MAX_BYTES} bytes (UTF-8), marking the cut. */
export function truncateAnchorBody(body: string, maxBytes: number = ANCHOR_ERROR_BODY_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= maxBytes) return body;
  // `fatal: false` drops a multi-byte sequence cut in half rather than throwing.
  return `${new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)).replace(/�+$/, "")}…[truncated]`;
}

/** Reads a response body, tolerating a stream that has already broken. */
async function readAnchorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Builds an {@link AnchorHttpError} from a failed `fetch` response, reading
 * (and bounding) its body. A body that cannot be read becomes an empty string.
 */
export async function anchorHttpError(sep: AnchorSep, op: string, res: Response): Promise<AnchorHttpError> {
  return new AnchorHttpError({ sep, op, status: res.status, body: await readAnchorBody(res) });
}

/** Client-safe one-line description, e.g. "The anchor returned an error (SEP-6 withdraw, HTTP 400)." */
export function anchorErrorSummary(err: AnchorHttpError): string {
  return `The anchor returned an error (SEP-${err.sep} ${err.op}, HTTP ${err.status}).`;
}

// ---------------------------------------------------------------------------
// Rejections, not outages (issue 3.29)
// ---------------------------------------------------------------------------

/**
 * Statuses where the anchor has actually answered the request: it read what we
 * sent and said no. 404 joins them because SEP-38 answers it for a pair the
 * anchor does not quote. 5xx, 429 and every transport failure stay failures.
 */
export const ANCHOR_REJECTION_STATUSES: readonly number[] = [400, 403, 404, 422];

export function isAnchorRejectionStatus(status: number): boolean {
  return ANCHOR_REJECTION_STATUSES.includes(status);
}

/** Bounds on the structured SEP error we are willing to carry. */
const REJECTION_TYPE_MAX_BYTES = 128;
const REJECTION_ERROR_MAX_BYTES = 512;
const REJECTION_FIELD_MAX_BYTES = 64;
const REJECTION_FIELDS_MAX = 20;

export interface AnchorRejectionDetail {
  /** SEP error `type`, e.g. `non_interactive_customer_info_needed`. */
  type?: string;
  /** Anchor's own human-readable reason. Server-side only — see {@link parseAnchorRejection}. */
  error?: string;
  /** SEP error `fields`, e.g. `["phone_number","id_number"]`. */
  fields?: string[];
}

/**
 * Pulls the structured SEP error (`{type, error, fields}`) out of a rejection
 * body. Anything that is not a JSON object — an HTML page, a stack trace, a
 * bare string — yields nothing, which is exactly the content issue 4.36 keeps
 * off the wire. Every value is separately bounded so a hostile anchor cannot
 * use this as a relay for an unbounded response.
 */
export function parseAnchorRejection(body: string): AnchorRejectionDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const detail: AnchorRejectionDetail = {};
  if (typeof record.type === "string") detail.type = truncateAnchorBody(record.type, REJECTION_TYPE_MAX_BYTES);
  if (typeof record.error === "string") detail.error = truncateAnchorBody(record.error, REJECTION_ERROR_MAX_BYTES);
  if (Array.isArray(record.fields)) {
    const fields = record.fields
      .filter((field): field is string => typeof field === "string")
      .slice(0, REJECTION_FIELDS_MAX)
      .map((field) => truncateAnchorBody(field, REJECTION_FIELD_MAX_BYTES));
    if (fields.length > 0) detail.fields = fields;
  }
  return detail;
}

/**
 * The anchor refused this request on its merits — an amount outside its
 * published limits, a pair it does not quote, KYC it wants finished first —
 * rather than being unable to answer. Extending {@link OffRampRejectedError}
 * is what exempts it from the circuit breaker and maps it to `422
 * offramp_rejected` instead of `502 anchor_error`.
 *
 * `message` stays text we wrote; the anchor's own wording travels separately
 * in `anchorError` for the operator's log, and `body` still never leaves the
 * server (issue 4.36).
 */
export class AnchorRejectedError extends OffRampRejectedError {
  readonly sep: AnchorSep;
  readonly op: string;
  readonly status: number;
  /** Truncated anchor response body. Log it; never return it to a client. */
  readonly body: string;
  readonly anchorType?: string;
  readonly anchorError?: string;
  readonly anchorFields?: string[];

  constructor(input: {
    sep: AnchorSep;
    op: string;
    status: number;
    body: string;
    anchorType?: string;
    anchorError?: string;
    anchorFields?: string[];
  }) {
    super(anchorRejectionSummary(input.sep, input.op, input.status));
    this.name = "AnchorRejectedError";
    this.sep = input.sep;
    this.op = input.op;
    this.status = input.status;
    this.body = truncateAnchorBody(input.body);
    this.anchorType = input.anchorType;
    this.anchorError = input.anchorError;
    this.anchorFields = input.anchorFields;
  }
}

/** Client-safe one-line description, e.g. "The anchor rejected this request (SEP-6 withdraw, HTTP 400)." */
export function anchorRejectionSummary(sep: AnchorSep, op: string, status: number): string {
  return `The anchor rejected this request (SEP-${sep} ${op}, HTTP ${status}).`;
}

/**
 * The error for a failed anchor call, classified once by status: 400/403/404/422
 * become {@link AnchorRejectedError}, everything else stays {@link AnchorHttpError}.
 * The body is read exactly once either way. Used by the two calls that carry a
 * seller's own request — SEP-6 `/withdraw` and SEP-38 quote; every other SEP
 * endpoint keeps plain {@link anchorHttpError}.
 */
export async function anchorCallError(
  sep: AnchorSep,
  op: string,
  res: Response,
): Promise<AnchorHttpError | AnchorRejectedError> {
  const body = await readAnchorBody(res);
  if (!isAnchorRejectionStatus(res.status)) return new AnchorHttpError({ sep, op, status: res.status, body });
  const detail = parseAnchorRejection(body);
  return new AnchorRejectedError({
    sep,
    op,
    status: res.status,
    body,
    anchorType: detail.type,
    anchorError: detail.error,
    anchorFields: detail.fields,
  });
}
