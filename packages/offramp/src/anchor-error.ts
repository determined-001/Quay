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

/** Cuts `body` to {@link ANCHOR_ERROR_BODY_MAX_BYTES} bytes (UTF-8), marking the cut. */
export function truncateAnchorBody(body: string, maxBytes: number = ANCHOR_ERROR_BODY_MAX_BYTES): string {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= maxBytes) return body;
  // `fatal: false` drops a multi-byte sequence cut in half rather than throwing.
  return `${new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)).replace(/�+$/, "")}…[truncated]`;
}

/**
 * Builds an {@link AnchorHttpError} from a failed `fetch` response, reading
 * (and bounding) its body. A body that cannot be read becomes an empty string.
 */
export async function anchorHttpError(sep: AnchorSep, op: string, res: Response): Promise<AnchorHttpError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return new AnchorHttpError({ sep, op, status: res.status, body });
}

/** Client-safe one-line description, e.g. "The anchor returned an error (SEP-6 withdraw, HTTP 400)." */
export function anchorErrorSummary(err: AnchorHttpError): string {
  return `The anchor returned an error (SEP-${err.sep} ${err.op}, HTTP ${err.status}).`;
}

/** HTTP statuses an anchor uses to say "I will not take this request". */
const REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 403, 422]);

/**
 * True when `err` is an anchor refusing a seller's own request (SEP-6
 * `/withdraw`, SEP-38 quote) with a 400, 403 or 422: an unsupported pair, an
 * amount it will not take, or "complete KYC first". That says nothing about the
 * anchor's health, so it is a rejection, not an outage. 5xx, 429 and network
 * errors are not.
 */
export function isAnchorRejection(err: unknown): err is AnchorHttpError {
  return (
    err instanceof AnchorHttpError &&
    REJECTION_STATUSES.has(err.status) &&
    ((err.sep === "6" && err.op === "withdraw") || (err.sep === "38" && err.op === "quote"))
  );
}

/**
 * The structured part of an anchor rejection that is safe to show the seller:
 * the SEP-6 `type` (e.g. `non_interactive_customer_info_needed`) and the names
 * of the `fields` it wants. The free-text `error` and any other content stay in
 * the server log, because an anchor can echo the seller's own KYC data there.
 */
export function anchorRejectionDetail(err: AnchorHttpError): { anchorType?: string; fields?: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.body);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { type, fields } = parsed as { type?: unknown; fields?: unknown };
  const token = /^[A-Za-z0-9_.-]{1,64}$/;
  const out: { anchorType?: string; fields?: string[] } = {};
  if (typeof type === "string" && token.test(type)) out.anchorType = type;
  if (Array.isArray(fields)) {
    const names = fields.filter((f): f is string => typeof f === "string" && token.test(f)).slice(0, 20);
    if (names.length > 0) out.fields = names;
  }
  return out;
}
