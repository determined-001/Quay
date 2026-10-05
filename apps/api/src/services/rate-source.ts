import type { RateSourcePort } from "@checkout/core";
import { HttpJsonRateSource, Sep38RateSource, StaticRateSource } from "@checkout/offramp";

/**
 * Build the FX rate source for anchors that do not implement SEP-38
 * (issue 3.22).
 *
 * Lives in its own module rather than inside `container.ts` because this is
 * configuration validation, and configuration validation wants tests. Every
 * branch here ends in a refusal: an operator who set half of what a rate source
 * needs should find out at BOOT, not when a seller is mid-cash-out. There is no
 * default that makes a missing value harmless, which is the point — a rate we
 * invent is a payout we got wrong.
 */
export interface RateSourceConfig {
  /** `sep38 | static | http`, or undefined for "no rate source configured". */
  kind: string | undefined;
  /** The anchor this deployment cashes out through; null when there is none. */
  anchorDomain: string | null;
  /** OFFRAMP value, for error messages that say what is misconfigured. */
  offramp: string;
  /** `static` parameters. */
  rate?: string;
  rateExpiresAt?: string;
  /** The target ISO code the configured rate/feed is for. */
  currency?: string;
  /** Optional: restrict the configured rate to one sell asset. */
  sourceAsset?: string;
  /** `http` parameters. */
  url?: string;
  jsonPath?: string;
  /**
   * Resolves the anchor's declared SEP-38 base URL, or null when it declares
   * none. Used by `sep38`.
   */
  resolveQuoteServer: () => Promise<string | null>;
  /**
   * SSRF guard for `http`, checked once at configuration time. The guard is
   * async, so it cannot run in a constructor.
   */
  guard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export async function createRateSource(cfg: RateSourceConfig): Promise<RateSourcePort | null> {
  if (!cfg.kind) return null;

  if (!cfg.anchorDomain) {
    throw new Error(
      `OFFRAMP_RATE_SOURCE=${cfg.kind} is set but this deployment has no anchor to source a rate for ` +
        `(OFFRAMP="${cfg.offramp}"). Set OFFRAMP=anchor or OFFRAMP=testanchor, or unset OFFRAMP_RATE_SOURCE.`,
    );
  }

  if (cfg.kind === "sep38") {
    // Indicative even when the anchor does have SEP-38: /prices is by
    // definition not a firm quote, which is why quotes from it are marked so.
    return new Sep38RateSource({ quoteServerFor: cfg.resolveQuoteServer });
  }

  if (cfg.kind === "static") {
    if (!cfg.rate) {
      throw new Error("OFFRAMP_RATE_SOURCE=static requires OFFRAMP_RATE (target units per 1 source unit)");
    }
    if (!cfg.rateExpiresAt) {
      throw new Error(
        "OFFRAMP_RATE_SOURCE=static requires OFFRAMP_RATE_EXPIRES_AT. A configured rate with no " +
          "expiry is a guess, and a stale rate quoted as live is worse than no quote at all.",
      );
    }
    if (!cfg.currency) {
      throw new Error("OFFRAMP_RATE_SOURCE=static requires OFFRAMP_RATE_CURRENCY (the target ISO code)");
    }
    return new StaticRateSource({
      rate: cfg.rate,
      expiresAt: cfg.rateExpiresAt,
      anchorDomain: cfg.anchorDomain,
      targetCurrency: cfg.currency,
      source: "static",
      ...(cfg.sourceAsset ? { sourceAssetCode: cfg.sourceAsset } : {}),
    });
  }

  if (cfg.kind === "http") {
    if (!cfg.url) throw new Error("OFFRAMP_RATE_SOURCE=http requires OFFRAMP_RATE_URL (https only)");
    if (!cfg.jsonPath) {
      throw new Error("OFFRAMP_RATE_SOURCE=http requires OFFRAMP_RATE_JSON_PATH (e.g. rate, data.price)");
    }
    if (!cfg.currency) {
      throw new Error("OFFRAMP_RATE_SOURCE=http requires OFFRAMP_RATE_CURRENCY (the target ISO code)");
    }
    const source = new HttpJsonRateSource({
      url: cfg.url,
      jsonPath: cfg.jsonPath,
      anchorDomain: cfg.anchorDomain,
      targetCurrency: cfg.currency,
      // Same guard as seller-supplied webhook URLs. This is operator config
      // rather than user input, but it is still an outbound request to a
      // hostname, and a "rate endpoint" resolving into a private range is a
      // misconfiguration to refuse rather than fetch.
      ...(cfg.guard ? { guard: cfg.guard } : {}),
      ...(cfg.sourceAsset ? { sourceAssetCode: cfg.sourceAsset } : {}),
    });
    await source.assertConfigured();
    return source;
  }

  throw new Error(`OFFRAMP_RATE_SOURCE must be one of sep38 | static | http (got "${cfg.kind}")`);
}
