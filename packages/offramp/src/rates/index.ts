// FX rate sources for anchors that do not implement SEP-38 (issue 3.22).
//
// Real anchors overwhelmingly declare TRANSFER_SERVER, WEB_AUTH_ENDPOINT,
// KYC_SERVER and DIRECT_PAYMENT_SERVER and no ANCHOR_QUOTE_SERVER — that is
// the whole reason the roadmap calls the unsolved FX quote the product. So the
// rate is a port (`RateSourcePort` in @checkout/core) and these are the
// implementations, one per kind of thing an operator can actually point at:
//
//   Sep38RateSource    — the anchor DOES quote, via /prices (indicative).
//   StaticRateSource   — a rate sheet the operator supplies. Testnet, and any
//                        anchor that gives you a number on a channel.
//   HttpJsonRateSource — the anchor publishes a rate somewhere that is not
//                        SEP-38 (a JSON endpoint on its own domain).
//
// Two rules every one of them obeys:
//
//   1. Direction is TARGET per SOURCE (issue 5.21). SEP-38's `price` is the
//      inverse, so Sep38RateSource inverts it via targetPerSourceRate rather
//      than passing it through — the mistake that made every spread meaningless.
//   2. Refuse rather than guess. No rate, an expired rate, or a rate for a
//      different corridor is an error, never a fallback number. A seller
//      committing to a stale figure is the failure mode this whole issue exists
//      to prevent.

import { NOOP_LOGGER, targetPerSourceRate, type FxRate, type Logger, type RateSourcePort } from "@checkout/core";
import { truncateAnchorBody } from "../anchor-error";
import { getSep38Prices } from "../sep38";

/** Thrown when a rate source cannot produce a usable, unexpired rate. */
export class RateUnavailableError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
    this.name = "RateUnavailableError";
  }
}

/** Reject a rate that is not a positive finite number, whatever produced it. */
function assertUsableRate(rate: string, source: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RateUnavailableError(source, `rate source "${source}" produced rate "${rate}", which is not a positive number`);
  }
  return rate;
}

/** Throws if `expiresAt` is not in the future. Refusing beats quoting a ghost. */
function assertFresh(fx: FxRate): FxRate {
  if (!Number.isFinite(fx.expiresAt)) {
    throw new RateUnavailableError(fx.source, `rate source "${fx.source}" returned a non-numeric expiresAt`);
  }
  if (fx.expiresAt <= Date.now()) {
    throw new RateUnavailableError(
      fx.source,
      `rate from "${fx.source}" expired at ${new Date(fx.expiresAt).toISOString()} — refusing to quote a stale rate`,
    );
  }
  return fx;
}

// ---------------------------------------------------------------------------
//  SEP-38 /prices
// ---------------------------------------------------------------------------

/**
 * An anchor that does implement SEP-38, read through `GET /prices`.
 *
 * Used for the indicative path when the operator has explicitly asked for it
 * (`OFFRAMP_RATE_SOURCE=sep38`): /prices costs no firm quote and needs no JWT,
 * but it is indicative by definition, so every quote it produces is
 * `indicative` however firm the POST /quote path would have been.
 */
export class Sep38RateSource implements RateSourcePort {
  constructor(
    private readonly opts: {
      /** Resolves the anchor's declared SEP-38 base URL, or null when it has none. */
      quoteServerFor(anchorDomain: string): Promise<string | null> | string | null;
      /** Default lifetime for a price that declares none, in ms. */
      defaultTtlMs?: number;
    },
  ) {}

  async rate(input: {
    anchorDomain: string;
    sourceAsset: { code: string; issuer: string | null };
    targetCurrency: string;
  }): Promise<FxRate> {
    const baseUrl = await this.opts.quoteServerFor(input.anchorDomain);
    if (!baseUrl) {
      throw new RateUnavailableError(
        "sep38",
        `anchor ${input.anchorDomain} declares no ANCHOR_QUOTE_SERVER, so SEP-38 cannot source a rate`,
      );
    }
    // /prices needs an amount to quote against; the caller does not have one
    // here, so ask with the smallest thing a price endpoint accepts and treat
    // the result as a rate rather than a quote.
    const entries = await getSep38Prices(baseUrl, { sellAsset: input.sourceAsset, sellAmount: "1" });
    const match = entries.find((e) => e.buyCurrency === input.targetCurrency.toUpperCase());
    if (!match) {
      throw new RateUnavailableError(
        "sep38",
        `SEP-38 /prices at ${baseUrl} does not quote ${input.targetCurrency}`,
      );
    }
    return assertFresh({
      // price is SOURCE per TARGET; FxRate is TARGET per SOURCE.
      rate: assertUsableRate(targetPerSourceRate(match.price), "sep38"),
      source: "sep38",
      asOf: Date.now(),
      expiresAt: Date.now() + (this.opts.defaultTtlMs ?? 60_000),
    });
  }
}

// ---------------------------------------------------------------------------
//  Static (operator-configured)
// ---------------------------------------------------------------------------

export interface StaticRateSourceOptions {
  /** The rate: TARGET units per 1 SOURCE unit. */
  rate: string;
  /**
   * When the configured rate stops being true. MANDATORY — there is no
   * sensible default, and an open-ended rate is a guess with a config file in
   * front of it. Accepts epoch ms or an ISO-8601 string.
   */
  expiresAt: number | string;
  /** Which anchor/currency pair this rate is for. Refuses anything else. */
  anchorDomain: string;
  targetCurrency: string;
  /** Optional: restrict to one sell asset. Refuses any other. */
  sourceAssetCode?: string;
  /** Label recorded on the returned FxRate; defaults to "static". */
  source?: string;
  now?: () => number;
}

/**
 * A rate the operator configured — a rate sheet, a pilot price, a testnet
 * number. The expiry is not optional and an expired one is refused: the whole
 * value of this class is that "we told the seller a number" means "we still
 * believe it", and an operator who has not refreshed the sheet has not.
 */
export class StaticRateSource implements RateSourcePort {
  private readonly configuredRate: string;
  private readonly expiresAt: number;
  private readonly now: () => number;

  constructor(private readonly opts: StaticRateSourceOptions) {
    if (opts.expiresAt === undefined || opts.expiresAt === null || opts.expiresAt === "") {
      throw new RateUnavailableError(
        opts.source ?? "static",
        "StaticRateSource requires expiresAt — a configured rate with no expiry is a guess, not a rate",
      );
    }
    const parsed = typeof opts.expiresAt === "number" ? opts.expiresAt : Date.parse(opts.expiresAt);
    if (!Number.isFinite(parsed)) {
      throw new RateUnavailableError(
        opts.source ?? "static",
        `StaticRateSource expiresAt "${String(opts.expiresAt)}" is not epoch ms or an ISO-8601 date`,
      );
    }
    this.configuredRate = assertUsableRate(opts.rate, opts.source ?? "static");
    this.expiresAt = parsed;
    this.now = opts.now ?? Date.now;
  }

  async rate(input: { anchorDomain: string; sourceAsset: { code: string }; targetCurrency: string }): Promise<FxRate> {
    if (input.anchorDomain !== this.opts.anchorDomain) {
      throw new RateUnavailableError(
        this.opts.source ?? "static",
        `static rate is configured for ${this.opts.anchorDomain}, not ${input.anchorDomain}`,
      );
    }
    if (input.targetCurrency.toUpperCase() !== this.opts.targetCurrency.toUpperCase()) {
      throw new RateUnavailableError(
        this.opts.source ?? "static",
        `static rate is configured for ${this.opts.targetCurrency}, not ${input.targetCurrency}`,
      );
    }
    if (this.opts.sourceAssetCode && this.opts.sourceAssetCode !== input.sourceAsset.code) {
      throw new RateUnavailableError(
        this.opts.source ?? "static",
        `static rate is configured for ${this.opts.sourceAssetCode}, not ${input.sourceAsset.code}`,
      );
    }
    const fx: FxRate = {
      rate: this.configuredRate,
      source: this.opts.source ?? "static",
      asOf: this.now(),
      expiresAt: this.expiresAt,
    };
    if (this.expiresAt <= this.now()) {
      throw new RateUnavailableError(
        fx.source,
        `static rate for ${this.opts.anchorDomain} expired at ${new Date(this.expiresAt).toISOString()} — ` +
          `refresh OFFRAMP_RATE_EXPIRES_AT rather than quoting a stale rate`,
      );
    }
    return assertFresh(fx);
  }
}

// ---------------------------------------------------------------------------
//  HTTP JSON
// ---------------------------------------------------------------------------

export interface HttpJsonRateSourceOptions {
  /** https:// URL that returns JSON. Enforced; see the constructor. */
  url: string;
  /**
   * Dotted path to the rate in the response, e.g. "rates.USDC_NGN" or
   * "data.rate". Numeric array indices are supported ("quotes.0.price").
   */
  jsonPath: string;
  /** Which anchor/currency pair this endpoint is for. Refuses anything else. */
  anchorDomain: string;
  targetCurrency: string;
  sourceAssetCode?: string;
  /** Default lifetime when the payload carries no expiry of its own, in ms. */
  defaultTtlMs?: number;
  /**
   * Validates the URL's host before any request — wired to the API's SSRF guard
   * at configuration time. Runs once in {@link assertConfigured}; an async guard
   * cannot run in the constructor.
   */
  guard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Largest response body accepted, in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** Server-side diagnostics only; nothing logged here reaches a client. */
  logger?: Logger;
  source?: string;
  now?: () => number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_HTTP_MAX_BODY_BYTES = 64 * 1024;

/** Reads a response body, refusing to buffer more than `maxBytes`. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * An anchor that publishes its rate somewhere other than SEP-38 — its own JSON
 * endpoint, a partner's, a dashboard API.
 *
 * The URL is operator configuration, not user input, but it is still an
 * outbound request to a hostname, so it goes through the same SSRF guard as
 * webhooks before the source is ever used. The guard is async, so validation
 * happens in {@link assertConfigured} (called at boot) rather than in the
 * constructor, and `https:` is checked synchronously on every request.
 */
export class HttpJsonRateSource implements RateSourcePort {
  private readonly now: () => number;

  constructor(private readonly opts: HttpJsonRateSourceOptions) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      // Not echoed: a configured URL can carry query-string credentials.
      throw new RateUnavailableError(opts.source ?? "http", "OFFRAMP_RATE_URL is not a valid URL");
    }
    // https only, unconditionally: this is a rate we quote to a seller, and a
    // plaintext hop is a MITM on the seller's payout amount.
    if (parsed.protocol !== "https:") {
      throw new RateUnavailableError(
        opts.source ?? "http",
        `OFFRAMP_RATE_URL must be https:// (got ${parsed.protocol}) — a rate fetched in plaintext is not a rate you can quote`,
      );
    }
    if (!opts.jsonPath) {
      throw new RateUnavailableError(opts.source ?? "http", "OFFRAMP_RATE_JSON_PATH is required");
    }
    this.now = opts.now ?? Date.now;
  }

  /** Run the configured SSRF guard. Call once at boot; throws on a rejected URL. */
  async assertConfigured(): Promise<void> {
    if (!this.opts.guard) return;
    const result = await this.opts.guard(this.opts.url);
    if (!result.ok) {
      throw new RateUnavailableError(
        this.opts.source ?? "http",
        `rate URL host ${new URL(this.opts.url).host} rejected by the SSRF guard: ${result.reason}`,
      );
    }
  }

  async rate(input: { anchorDomain: string; sourceAsset: { code: string }; targetCurrency: string }): Promise<FxRate> {
    if (input.anchorDomain !== this.opts.anchorDomain) {
      throw new RateUnavailableError(
        this.opts.source ?? "http",
        `rate endpoint is configured for ${this.opts.anchorDomain}, not ${input.anchorDomain}`,
      );
    }
    if (input.targetCurrency.toUpperCase() !== this.opts.targetCurrency.toUpperCase()) {
      throw new RateUnavailableError(
        this.opts.source ?? "http",
        `rate endpoint is configured for ${this.opts.targetCurrency}, not ${input.targetCurrency}`,
      );
    }
    if (this.opts.sourceAssetCode && this.opts.sourceAssetCode !== input.sourceAsset.code) {
      throw new RateUnavailableError(
        this.opts.source ?? "http",
        `rate endpoint is configured for ${this.opts.sourceAssetCode}, not ${input.sourceAsset.code}`,
      );
    }

    const source = this.opts.source ?? "http";
    const log = (this.opts.logger ?? NOOP_LOGGER).child({ component: "rate-source", source });
    const maxBytes = this.opts.maxBodyBytes ?? DEFAULT_HTTP_MAX_BODY_BYTES;

    // The SSRF guard validated the configured URL once, at boot. `redirect:
    // "error"` keeps a 30x from walking the request to a host it never
    // checked, and the timeout keeps a slow endpoint from holding the quote.
    // Errors from here are generic: neither the URL (it may carry a secret in
    // its query string) nor the remote body ever reaches a message.
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      log.warn({ event: "rate.http.fetch_failed", error: err instanceof Error ? err.name : "unknown" }, "rate fetch failed");
      throw new RateUnavailableError(source, "rate endpoint could not be reached (timeout, redirect, or network error)");
    }
    if (!res.ok) {
      const detail = await readBoundedText(res, 2048).catch(() => null);
      log.warn(
        { event: "rate.http.bad_status", statusCode: res.status, body: truncateAnchorBody(detail ?? "") },
        "rate endpoint returned a non-2xx status",
      );
      throw new RateUnavailableError(source, `rate endpoint returned HTTP ${res.status}`);
    }
    let text: string | null;
    try {
      text = await readBoundedText(res, maxBytes);
    } catch {
      throw new RateUnavailableError(source, "rate endpoint response could not be read");
    }
    if (text === null) {
      throw new RateUnavailableError(source, `rate endpoint response exceeds ${maxBytes} bytes`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RateUnavailableError(source, "rate endpoint did not return valid JSON");
    }
    const found = readPath(body, this.opts.jsonPath);
    if (typeof found !== "string" && typeof found !== "number") {
      throw new RateUnavailableError(source, `rate endpoint: no value at JSON path "${this.opts.jsonPath}"`);
    }

    // The endpoint may shorten the rate's life but never extend it: a remote
    // that says "valid until 2099" would otherwise turn a stale number into
    // one we quote to sellers indefinitely. Capped at now + our own TTL.
    const now = this.now();
    const ceiling = now + (this.opts.defaultTtlMs ?? 60_000);
    const expires = readPath(body, "expiresAt") ?? readPath(body, "expires_at");
    const remoteExpiry =
      typeof expires === "number"
        ? expires
        : typeof expires === "string" && Number.isFinite(Date.parse(expires))
          ? Date.parse(expires)
          : undefined;
    const expiresAt = remoteExpiry === undefined ? ceiling : Math.min(remoteExpiry, ceiling);

    return assertFresh({
      rate: assertUsableRate(String(found), this.opts.source ?? "http"),
      source: source,
      asOf: this.now(),
      expiresAt,
    });
  }
}

/** Resolve a dotted path (with numeric indices) against a parsed JSON value. */
export function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) return acc[Number(key)];
    if (typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}
