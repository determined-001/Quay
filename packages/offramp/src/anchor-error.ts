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
