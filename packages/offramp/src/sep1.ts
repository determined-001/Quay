import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

/**
 * SEP-1 (`stellar.toml`) discovery.
 *
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md
 *
 * Endpoint paths used to be hardcoded to testanchor's layout, which made every
 * new anchor a code change rather than configuration (issue #14). Everything an
 * anchor exposes is declared in its TOML; this reads it, so `homeDomain` is the
 * only configuration a deployment needs.
 *
 * Two things here are security-relevant rather than convenience:
 *
 * - `signingKey` is the account a SEP-10 challenge MUST be signed by. Without
 *   it a client signs whatever transaction the server hands back, which is the
 *   entire attack surface of SEP-10 (see sep10.ts).
 * - `networkPassphrase` is checked against the network we are actually on, so a
 *   mainnet deployment cannot be pointed at a testnet anchor (or the reverse)
 *   by a typo in one env var.
 */
export interface Sep1DiscoveryInfo {
  /** SEP-10 web auth endpoint. */
  webAuthEndpoint: string;
  /** SEP-6 transfer server. */
  transferServer: string;
  /** SEP-24 interactive transfer server. */
  transferServerSep24: string;
  /** SEP-38 quote server. */
  anchorQuoteServer: string;
  /** SEP-12 KYC server. Anchors that omit it serve KYC from the transfer server. */
  kycServer: string;
  /** The account that signs SEP-10 challenges. Null when the anchor omits it. */
  signingKey: string | null;
  /** Declared network passphrase, or null when the anchor omits it. */
  networkPassphrase: string | null;
  /** Asset codes listed in [[CURRENCIES]]. Empty when none are declared. */
  currencies: string[];
  homeDomain: string;
  /**
   * True when discovery failed and these are guessed defaults rather than
   * anything the anchor said. Callers that care about authenticity — SEP-10
   * above all — must refuse to proceed on a fallback.
   */
  fallback: boolean;
}

/**
 * Join a SEP endpoint path onto a transfer-server base URL.
 *
 * `new URL("/transaction", base)` is an *absolute* path: it replaces the base's
 * own path, so a TOML that advertises `https://anchor.example/sep24` silently
 * becomes `https://anchor.example/transaction`. testanchor.stellar.org does
 * exactly this, and answered every SEP-24 call with
 * `404 No static resource transactions/withdraw/interactive.` until this joined
 * the path onto the base instead of over it.
 */
export function endpointUrl(base: string, path: string): URL {
  return new URL(`${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

/** How long a successful TOML is reused before being re-fetched. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  at: number;
  info: Sep1DiscoveryInfo;
}

const cache = new Map<string, CacheEntry>();

/** Drop cached discovery — for tests, and for an operator forcing a re-read. */
export function clearStellarTomlCache(homeDomain?: string): void {
  if (homeDomain) cache.delete(homeDomain);
  else cache.clear();
}

export class Sep1NetworkMismatchError extends Error {
  constructor(
    readonly homeDomain: string,
    readonly declared: string,
    readonly expected: string,
  ) {
    super(
      `Anchor ${homeDomain} declares NETWORK_PASSPHRASE "${declared}", but this deployment is on "${expected}". ` +
        `Refusing to use it: an anchor on the wrong network cannot settle our payments.`,
    );
    this.name = "Sep1NetworkMismatchError";
  }
}

export interface FetchTomlOptions {
  /** Our network's passphrase. When given, a declared mismatch throws. */
  expectedNetworkPassphrase?: string;
  logger?: Logger;
  /** Skip the cache for this call (the result is still cached). */
  force?: boolean;
}

/**
 * Fetch, parse and cache `https://<homeDomain>/.well-known/stellar.toml`.
 *
 * A fetch or parse failure returns guessed defaults with `fallback: true` and
 * logs a warning rather than throwing — the SEP-6/38 paths it guesses are the
 * common layout and were what this code hardcoded before. A *network mismatch*
 * is different and does throw: continuing there risks settling against the
 * wrong chain, which no fallback can make safe. Fallbacks are not cached, so a
 * transient outage does not pin bad endpoints for five minutes.
 */
export async function fetchStellarToml(
  homeDomain: string,
  opts: FetchTomlOptions = {},
): Promise<Sep1DiscoveryInfo> {
  const log = (opts.logger ?? NOOP_LOGGER).child({ component: "sep1", homeDomain });

  if (!opts.force) {
    const hit = cache.get(homeDomain);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  }

  const url = `https://${homeDomain}/.well-known/stellar.toml`;
  let info: Sep1DiscoveryInfo;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`stellar.toml fetch returned ${res.status}`);
    info = parseStellarToml(await res.text(), homeDomain);
  } catch (err) {
    log.warn(
      { event: "anchor.sep1.fallback", reason: err instanceof Error ? err.message : String(err) },
      "SEP-1 discovery failed; falling back to guessed endpoint paths",
    );
    return fallbackInfo(homeDomain);
  }

  if (
    opts.expectedNetworkPassphrase &&
    info.networkPassphrase &&
    info.networkPassphrase !== opts.expectedNetworkPassphrase
  ) {
    throw new Sep1NetworkMismatchError(homeDomain, info.networkPassphrase, opts.expectedNetworkPassphrase);
  }

  cache.set(homeDomain, { at: Date.now(), info });
  log.info(
    {
      event: "anchor.sep1.ok",
      signingKey: info.signingKey,
      currencies: info.currencies,
    },
    "SEP-1 discovery ok",
  );
  return info;
}

function fallbackInfo(homeDomain: string): Sep1DiscoveryInfo {
  return {
    webAuthEndpoint: `https://${homeDomain}/auth`,
    transferServer: `https://${homeDomain}/sep6`,
    transferServerSep24: `https://${homeDomain}/sep24`,
    anchorQuoteServer: `https://${homeDomain}/sep38`,
    kycServer: `https://${homeDomain}/sep12`,
    signingKey: null,
    networkPassphrase: null,
    currencies: [],
    homeDomain,
    fallback: true,
  };
}

/**
 * Minimal TOML reader for the handful of keys SEP-1 defines that we use.
 *
 * Deliberately not a general TOML parser: this runs against a file fetched
 * from a third party, and the subset we need is flat key/value pairs plus the
 * `code` of each `[[CURRENCIES]]` block. A full parser would be more surface
 * area for no more capability.
 */
export function parseStellarToml(tomlText: string, homeDomain: string): Sep1DiscoveryInfo {
  const base = fallbackInfo(homeDomain);
  const info: Sep1DiscoveryInfo = { ...base, fallback: false };
  const currencies: string[] = [];
  let inCurrency = false;
  let sawKycServer = false;

  for (const line of tomlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      // Any table header ends the flat top-level section; only [[CURRENCIES]]
      // is one we read fields out of.
      inCurrency = /^\[\[\s*CURRENCIES\s*\]\]$/i.test(trimmed);
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = unquote(trimmed.slice(eq + 1).trim());
    if (!val) continue;

    if (inCurrency) {
      if (key === "code") currencies.push(val);
      continue;
    }

    switch (key) {
      case "WEB_AUTH_ENDPOINT":
      case "WEB_AUTH_URL":
        info.webAuthEndpoint = val;
        break;
      case "TRANSFER_SERVER":
        info.transferServer = val;
        break;
      case "TRANSFER_SERVER_SEP0024":
      case "TRANSFER_SERVER_SEP24":
        info.transferServerSep24 = val;
        break;
      case "ANCHOR_QUOTE_SERVER":
        info.anchorQuoteServer = val;
        break;
      case "KYC_SERVER":
        info.kycServer = val;
        sawKycServer = true;
        break;
      case "SIGNING_KEY":
        info.signingKey = val;
        break;
      case "NETWORK_PASSPHRASE":
        info.networkPassphrase = val;
        break;
      default:
        break;
    }
  }

  // An anchor that declares no KYC server serves SEP-12 from its transfer
  // server — that is what the spec says, and guessing /sep12 would 404.
  // Keyed on whether the field was present, not on whether its value happens
  // to equal the guess: plenty of anchors do publish `<domain>/sep12`.
  if (!sawKycServer) info.kycServer = info.transferServer;

  info.currencies = currencies;
  return info;
}

/** Whether the anchor lists `code` in its [[CURRENCIES]]. */
export function listsCurrency(info: Sep1DiscoveryInfo, code: string): boolean {
  // An anchor that declares no currencies at all is not asserting the asset is
  // absent, so this cannot be treated as a rejection.
  if (info.currencies.length === 0) return true;
  return info.currencies.some((c) => c.toUpperCase() === code.toUpperCase());
}

function unquote(raw: string): string {
  const val = raw.trim();
  const quote = val[0];
  if (quote === '"' || quote === "'") {
    // Take the quoted span and ignore whatever follows it (a trailing comment).
    const close = val.indexOf(quote, 1);
    if (close !== -1) return val.slice(1, close);
    return val.slice(1);
  }
  const hash = val.indexOf(" #");
  return (hash === -1 ? val : val.slice(0, hash)).trim();
}
