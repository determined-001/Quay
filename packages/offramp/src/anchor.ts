import {
  fetchStellarToml,
  findCurrency,
  normalizeHomeDomain,
  StellarTomlError,
  type StellarToml,
} from "./sep1";

// Resolves one anchor's endpoints from its SEP-1 stellar.toml, so the only
// configuration an adapter needs is a home domain.
//
// The hard-coded paths below are the testanchor layout that used to be compiled
// into sep10/sep38/sep6/sep12. They survive only as a last-resort fallback for
// an anchor whose TOML omits a service entry, and every use logs a warning:
// falling back is a guess about someone else's URL space, and the whole point of
// SEP-1 is not to guess.

const FALLBACK_PATHS = {
  webAuthEndpoint: "/auth",
  transferServer: "/sep6",
  kycServer: "/sep12",
  anchorQuoteServer: "/sep38",
} as const;

export type AnchorService = keyof typeof FALLBACK_PATHS;

const SERVICE_TOML_KEY: Record<AnchorService, string> = {
  webAuthEndpoint: "WEB_AUTH_ENDPOINT",
  transferServer: "TRANSFER_SERVER",
  kycServer: "KYC_SERVER",
  anchorQuoteServer: "ANCHOR_QUOTE_SERVER",
};

/** Endpoints for one anchor, each resolved from the TOML or explicitly fallen back. */
export interface ResolvedAnchor {
  homeDomain: string;
  /** SEP-10 SIGNING_KEY. `null` when the anchor publishes none — SEP-10 then refuses to sign. */
  signingKey: string | null;
  networkPassphrase: string | null;
  webAuthEndpoint: string;
  transferServer: string;
  kycServer: string;
  anchorQuoteServer: string;
  /** Services that came from FALLBACK_PATHS rather than the TOML. */
  fellBackFor: AnchorService[];
  toml: StellarToml;
}

export interface Logger {
  warn(message: string): void;
}

const defaultLogger: Logger = { warn: (m) => console.warn(m) };

export interface ResolveAnchorOptions {
  /** Base URL for fallback paths. Defaults to `https://<homeDomain>`. */
  baseUrl?: string;
  /** Reject the anchor if its NETWORK_PASSPHRASE disagrees. */
  expectedNetworkPassphrase?: string;
  forceRefresh?: boolean;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches the anchor's stellar.toml (5-minute cache) and resolves every endpoint
 * the off-ramp needs. Throws `StellarTomlError` when the TOML is unreachable,
 * unparsable, or declares a different network than this deployment runs on.
 */
export async function resolveAnchor(
  homeDomain: string,
  opts: ResolveAnchorOptions = {},
): Promise<ResolvedAnchor> {
  const domain = normalizeHomeDomain(homeDomain);
  const logger = opts.logger ?? defaultLogger;
  const toml = await fetchStellarToml(domain, {
    expectedNetworkPassphrase: opts.expectedNetworkPassphrase,
    forceRefresh: opts.forceRefresh,
    fetchImpl: opts.fetchImpl,
  });

  const baseUrl = opts.baseUrl ?? `https://${domain}`;
  const fellBackFor: AnchorService[] = [];

  const resolve = (service: AnchorService): string => {
    const fromToml = toml[service];
    if (fromToml) return stripTrailingSlash(fromToml);
    fellBackFor.push(service);
    const guess = new URL(FALLBACK_PATHS[service], baseUrl).toString();
    logger.warn(
      `[SEP-1] ${domain} publishes no ${SERVICE_TOML_KEY[service]} in its stellar.toml — ` +
        `falling back to the hard-coded path ${stripTrailingSlash(guess)}. This is a guess about ` +
        `the anchor's URL space and may break without notice; ask the anchor to publish ` +
        `${SERVICE_TOML_KEY[service]}.`,
    );
    return stripTrailingSlash(guess);
  };

  if (!toml.signingKey) {
    logger.warn(
      `[SEP-1] ${domain} publishes no SIGNING_KEY in its stellar.toml — SEP-10 challenges from ` +
        `this anchor cannot be verified and will be refused rather than signed.`,
    );
  }

  return {
    homeDomain: domain,
    signingKey: toml.signingKey,
    networkPassphrase: toml.networkPassphrase,
    webAuthEndpoint: resolve("webAuthEndpoint"),
    transferServer: resolve("transferServer"),
    kycServer: resolve("kycServer"),
    anchorQuoteServer: resolve("anchorQuoteServer"),
    fellBackFor,
    toml,
  };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Confirms the anchor's `[[CURRENCIES]]` actually lists the asset we're about to
 * withdraw, so a wrong issuer fails here with a readable message instead of as
 * an opaque SEP-6 rejection.
 *
 * A TOML with no CURRENCIES at all is not treated as a rejection: SEP-1 allows
 * currencies to be published at a separate `CURRENCIES` URL that we don't
 * follow, so absence is unknown, not "unsupported".
 */
export function assertCurrencySupported(
  anchor: ResolvedAnchor,
  asset: { code: string; issuer: string | null },
  logger: Logger = defaultLogger,
): void {
  const found = findCurrency(anchor.toml, asset);

  if (found === undefined) {
    logger.warn(
      `[SEP-1] ${anchor.homeDomain} lists no CURRENCIES in its stellar.toml — cannot confirm ` +
        `${asset.code} is supported before attempting the withdrawal.`,
    );
    return;
  }

  if (found === null) {
    const listed = anchor.toml.currencies
      .map((c) => (c.issuer ? `${c.code}:${c.issuer.slice(0, 8)}…` : c.code))
      .filter(Boolean)
      .join(", ");
    const wanted = asset.issuer ? `${asset.code} issued by ${asset.issuer}` : `native ${asset.code}`;
    throw new StellarTomlError(
      `${anchor.homeDomain} does not list ${wanted} in its stellar.toml CURRENCIES. ` +
        `It advertises: ${listed || "(none)"}.`,
    );
  }

  // Listed but explicitly retired — the anchor is telling us not to use it.
  if (found.status === "dead") {
    throw new StellarTomlError(
      `${anchor.homeDomain} lists ${asset.code} with status "dead" — it is no longer redeemable.`,
    );
  }
}
