import { Asset } from "@stellar/stellar-sdk";
import type { AssetRef } from "@checkout/core";
import {
  assetEquals,
  fromStroops,
  normalizeAmount,
  toStroops,
} from "@checkout/core";
import type { HorizonClient } from "./horizon-client";
import { withHorizonRetry } from "./horizon-retry";

/** One cheapest way to pay a fixed destination amount, from one source asset. */
export interface PathQuote {
  sourceAsset: AssetRef;
  /** Canonical decimal string (see `normalizeAmount`). */
  sourceAmount: string;
  /** Intermediate assets, in order, between source and destination. */
  path: AssetRef[];
}

export interface QuoteStrictReceiveInput {
  client: HorizonClient;
  /** Buyer account id, or the list of assets the buyer is willing to pay with. */
  source: string | AssetRef[];
  destAsset: AssetRef;
  /** Fixed destination amount, canonical decimal string. */
  destAmount: string;
}

function toSdkAsset(ref: AssetRef): Asset {
  return ref.issuer === null ? Asset.native() : new Asset(ref.code, ref.issuer);
}

/** Horizon omits `asset_code`/`asset_issuer` for native assets; the type
 *  alone decides whether a record entry is XLM. */
function assetFromRecord(
  assetType: string,
  assetCode: string | undefined,
  assetIssuer: string | undefined,
): AssetRef {
  if (assetType === "native") return { code: "XLM", issuer: null };
  return { code: assetCode ?? "", issuer: assetIssuer ?? null };
}

function assetKey(asset: AssetRef): string {
  return asset.issuer === null ? `native:${asset.code}` : `${asset.code}:${asset.issuer}`;
}

/**
 * Asks Horizon `GET /paths/strict-receive` for the cheapest way to deliver
 * `destAmount` of `destAsset`, one quote per source asset, sorted by source
 * asset code. Records whose source asset equals the destination asset are
 * plain payments, not paths, and are dropped. The Horizon call is wrapped in
 * `withHorizonRetry`, like the watcher (issue #545).
 */
export async function quoteStrictReceive(
  input: QuoteStrictReceiveInput,
): Promise<PathQuote[]> {
  const { client, source, destAsset, destAmount } = input;
  const sdkSource = typeof source === "string" ? source : source.map(toSdkAsset);
  const page = await withHorizonRetry(() =>
    client
      .strictReceivePaths(sdkSource, toSdkAsset(destAsset), destAmount)
      .call(),
  );

  const cheapest = new Map<string, PathQuote>();
  for (const record of page.records) {
    const sourceAsset = assetFromRecord(
      record.source_asset_type,
      record.source_asset_code,
      record.source_asset_issuer,
    );
    if (assetEquals(sourceAsset, destAsset)) continue;
    const quote: PathQuote = {
      sourceAsset,
      sourceAmount: normalizeAmount(record.source_amount),
      path: record.path.map((hop) =>
        assetFromRecord(hop.asset_type, hop.asset_code, hop.asset_issuer),
      ),
    };
    const key = assetKey(sourceAsset);
    const existing = cheapest.get(key);
    if (
      !existing ||
      toStroops(quote.sourceAmount) < toStroops(existing.sourceAmount)
    ) {
      cheapest.set(key, quote);
    }
  }

  return [...cheapest.values()].sort(
    (a, b) =>
      a.sourceAsset.code.localeCompare(b.sourceAsset.code) ||
      (a.sourceAsset.issuer ?? "").localeCompare(b.sourceAsset.issuer ?? ""),
  );
}

/**
 * Maximum send amount for a quoted source amount at a given slippage, in
 * basis points (100 bps = 1%). Exact stroop math, rounded UP to the next
 * stroop — the one place slippage is applied (issue #545). Never rounds down:
 * even 1 stroop of slippage costs a whole extra stroop.
 */
export function sendMaxFor(sourceAmount: string, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new Error(
      `slippageBps must be a non-negative integer, got ${slippageBps}`,
    );
  }
  const stroops = toStroops(sourceAmount); // throws on an invalid amount
  const numerator = stroops * BigInt(10_000 + slippageBps);
  const sendMaxStroops = (numerator + 9_999n) / 10_000n; // ceil: never rounds down
  return fromStroops(sendMaxStroops);
}

/** A strict-receive quote reduced to its two amounts, for price comparison. */
export interface QuotedAmounts {
  /** What the buyer sends, canonical decimal string. */
  sourceAmount: string;
  /** What the seller receives, canonical decimal string. */
  destAmount: string;
}

/**
 * Price impact of paying the full amount, in basis points (issue #547): how
 * much worse the per-unit price of the full quote is than the per-unit price
 * of a quote for a small slice of it (1% in practice). A thin order book shows
 * up as a full quote that costs proportionally more than the small one.
 *
 *   impact = (full source per dest unit / small source per dest unit) - 1
 *
 * Exact stroop math, rounded UP so a borderline book is treated as too thin;
 * never negative (a full quote priced better than the slice is 0 impact).
 */
export function priceImpactBps(full: QuotedAmounts, small: QuotedAmounts): number {
  const fullSource = toStroops(full.sourceAmount);
  const fullDest = toStroops(full.destAmount);
  const smallSource = toStroops(small.sourceAmount);
  const smallDest = toStroops(small.destAmount);
  if (fullSource <= 0n || fullDest <= 0n || smallSource <= 0n || smallDest <= 0n) {
    throw new Error("priceImpactBps needs positive amounts on both quotes");
  }
  // fullSource/fullDest vs smallSource/smallDest, cross-multiplied.
  const fullCost = fullSource * smallDest;
  const smallCost = smallSource * fullDest;
  if (fullCost <= smallCost) return 0;
  const numerator = (fullCost - smallCost) * 10_000n;
  return Number((numerator + smallCost - 1n) / smallCost); // ceil
}

/**
 * Drops pay options whose price impact is above the limit (issue #547). When
 * nothing survives, the buyer can only pay in the link asset: `reason` is
 * `"no_path"` so the checkout can say why.
 */
export function filterByPriceImpact<T extends { priceImpactBps: number }>(
  options: T[],
  maxPriceImpactBps: number,
): { options: T[]; reason: "no_path" | null } {
  const kept = options.filter((o) => o.priceImpactBps <= maxPriceImpactBps);
  return { options: kept, reason: kept.length === 0 ? "no_path" : null };
}
