/**
 * HTTP helper for anchor calls with configurable timeout and typed AnchorTimeoutError.
 */

export const DEFAULT_ANCHOR_TIMEOUT_MS = 10_000;

export class AnchorTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Anchor HTTP request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "AnchorTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export interface AnchorFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * Executes a fetch request to an anchor with an AbortSignal timeout.
 * Combines caller's signal (if provided) with a timeout signal.
 * Throws AnchorTimeoutError if the timeout fires.
 */
export async function anchorFetch(
  input: string | URL | Request,
  init?: AnchorFetchOptions,
  timeoutMs: number = DEFAULT_ANCHOR_TIMEOUT_MS,
): Promise<Response> {
  const effectiveTimeout = init?.timeoutMs ?? timeoutMs;
  const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  try {
    return await fetch(input, {
      ...init,
      signal,
    });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new AnchorTimeoutError(urlStr, effectiveTimeout);
    }
    throw err;
  }
}
