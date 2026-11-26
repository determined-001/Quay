import { fromStroops, toStroops, type AssetRef } from "@checkout/core";
import {
  filterByPriceImpact,
  priceImpactBps,
  quoteStrictReceive,
  type HorizonAccountBalance,
  type HorizonClient,
} from "@checkout/stellar";
import type { Asset } from "@stellar/stellar-sdk";

/**
 * Build-time re-quoting and transaction construction for the buyer's wallet
 * payment (issue 5.48).
 *
 * `GET /links/:id/pay-options` (4.64) quotes what each asset would cost when
 * the panel opens. That price is advisory: by the time the buyer picks an asset
 * and signs, the order book has moved. So the chosen asset is quoted again here
 * — against the outstanding amount, for this buyer's account — and the result
 * is what the transaction is built from. The buyer's accepted `maxSourceAmount`
 * stays the `sendMax` cap, so a worse price can never cost them more than the
 * figure the panel showed them.
 *
 * Price impact is enforced here too, which is why 4.64 does not filter thin
 * books: the checkout must keep offering the link asset cheaply, but an
 * unfavourable conversion is only worth refusing at the moment of paying.
 */

/** The two ways a chosen asset can be refused at build time. Both map onto
 *  error codes the wallet panel already knows how to explain. */
export type PathPaymentErrorCode = "no_path" | "price_moved";

export class PathPaymentError extends Error {
  constructor(
    readonly code: PathPaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PathPaymentError";
  }
}

/**
 * Horizon as this module needs it: the quote call from `HorizonClient`, plus an
 * account load that also carries the sequence the transaction is built on.
 * Structurally satisfied by `Horizon.Server`, and narrow enough that tests can
 * drive it in memory.
 */
export interface PaymentHorizon extends HorizonClient {
  loadAccount(account: string): Promise<{
    sequence: string;
    balances: HorizonAccountBalance[];
    subentry_count?: number;
  }>;
}

export interface PathPaymentOption {
  /** The asset the buyer would send instead of the link asset (`PayOption.sourceAsset`). */
  sourceAsset: AssetRef;
  /** The slippage-capped amount the buyer accepted when they chose this asset. */
  sendMax: string;
}

export interface PlanPathPaymentInput {
  client: HorizonClient;
  /** The buyer's account: paths depend on what that account can hold. */
  buyer: string;
  /** The link's asset — what the destination must receive. */
  destAsset: AssetRef;
  /** What is still owed, canonical decimal string. */
  destAmount: string;
  option: PathPaymentOption;
  maxPriceImpactBps: number;
}

export interface PlannedPathPayment {
  sourceAsset: AssetRef;
  /** Fresh quote for the outstanding amount — what the buyer will really send. */
  sourceAmount: string;
  /** Intermediate assets, in order, between source and destination. */
  path: AssetRef[];
  /** The accepted cap; becomes the operation's `sendMax`. */
  maxSourceAmount: string;
  priceImpactBps: number;
}

/**
 * Re-quotes `option.sourceAsset` for the outstanding destination amount and refuses
 * the payment when the fresh price is outside what the buyer accepted:
 *
 * - no path (or a path that vanished between the panel and the press)
 * - price impact above `maxPriceImpactBps` — a thin book would deliver the
 *   amount but at a materially worse rate than the market's best
 * - a required source amount above `maxSourceAmount` — the slippage guard
 *
 * Two Horizon calls, made once per payment rather than once per page load:
 * the full amount, and a 1% slice used only to measure impact.
 */
export async function planPathPayment(
  input: PlanPathPaymentInput,
): Promise<PlannedPathPayment> {
  const { client, buyer, destAsset, destAmount, option, maxPriceImpactBps } =
    input;

  const quotes = await quoteStrictReceive({
    client,
    source: buyer,
    destAsset,
    destAmount,
  });
  const fresh = quotes.find((quote) => sameAsset(quote.sourceAsset, option.sourceAsset));
  if (!fresh) {
    throw new PathPaymentError(
      "no_path",
      `There is no path from ${option.sourceAsset.code} to ${destAsset.code}.`,
    );
  }

  // A 1% slice prices the easy part of the book; the gap between it and the
  // full amount is the impact the buyer would pay for liquidity.
  const sliceDestAmount = onePercentOf(destAmount);
  const sliceQuotes = await quoteStrictReceive({
    client,
    source: buyer,
    destAsset,
    destAmount: sliceDestAmount,
  });
  const slice = sliceQuotes.find((quote) => sameAsset(quote.sourceAsset, option.sourceAsset));
  if (!slice) {
    throw new PathPaymentError(
      "no_path",
      `There is no path from ${option.sourceAsset.code} to ${destAsset.code}.`,
    );
  }

  const impact = priceImpactBps(
    { sourceAmount: fresh.sourceAmount, destAmount },
    { sourceAmount: slice.sourceAmount, destAmount: sliceDestAmount },
  );

  // The cap is applied with the same helper (and the same `<=` boundary) the
  // checkout uses everywhere else, so the rule has one definition.
  const { options } = filterByPriceImpact([{ fresh, priceImpactBps: impact }], maxPriceImpactBps);
  if (options.length === 0) {
    throw new PathPaymentError(
      "no_path",
      `Paying in ${option.sourceAsset.code} would cost ${impact} bps more than the market price, above the ${maxPriceImpactBps} bps limit.`,
    );
  }

  if (toStroops(fresh.sourceAmount) > toStroops(option.sendMax)) {
    throw new PathPaymentError(
      "price_moved",
      `The ${option.sourceAsset.code} price moved: this payment now needs ${fresh.sourceAmount}, but at most ${option.sendMax} was quoted.`,
    );
  }

  return {
    sourceAsset: fresh.sourceAsset,
    sourceAmount: fresh.sourceAmount,
    path: fresh.path,
    maxSourceAmount: option.sendMax,
    priceImpactBps: impact,
  };
}

export interface BuildPaymentXdrInput {
  address: string;
  sequence: string;
  destination: string;
  destAsset: AssetRef;
  /** What the destination receives, canonical decimal string. */
  destAmount: string;
  networkPassphrase: string;
  memo?: string | null;
  feeStroops?: bigint;
}

export interface BuildPathPaymentXdrInput extends BuildPaymentXdrInput {
  plan: PlannedPathPayment;
}

/** Standard `payment` in the link asset — the unchanged path (5.47 default). */
export async function buildDirectPaymentXdr(
  input: BuildPaymentXdrInput,
): Promise<string> {
  const stellar = await import("@stellar/stellar-sdk");
  const builder = new stellar.TransactionBuilder(
    new stellar.Account(input.address, input.sequence),
    { fee: String(input.feeStroops ?? 100n), networkPassphrase: input.networkPassphrase },
  ).addOperation(
    stellar.Operation.payment({
      destination: input.destination,
      asset: toSdkAsset(stellar, input.destAsset),
      amount: input.destAmount,
    }),
  );

  return finish(stellar, builder, input);
}

/**
 * `pathPaymentStrictReceive` (issue 5.48): the buyer sends `plan.sourceAsset`,
 * the destination receives exactly `destAmount` of the link asset, and
 * `sendMax` is the cap the buyer already accepted — never the fresh quote, so a
 * price move inside the allowance favours them rather than re-pricing upward.
 */
export async function buildPathPaymentXdr(
  input: BuildPathPaymentXdrInput,
): Promise<string> {
  const stellar = await import("@stellar/stellar-sdk");
  const builder = new stellar.TransactionBuilder(
    new stellar.Account(input.address, input.sequence),
    { fee: String(input.feeStroops ?? 100n), networkPassphrase: input.networkPassphrase },
  ).addOperation(
    stellar.Operation.pathPaymentStrictReceive({
      sendAsset: toSdkAsset(stellar, input.plan.sourceAsset),
      sendMax: input.plan.maxSourceAmount,
      destination: input.destination,
      destAsset: toSdkAsset(stellar, input.destAsset),
      destAmount: input.destAmount,
      path: input.plan.path.map((hop) => toSdkAsset(stellar, hop)),
    }),
  );

  return finish(stellar, builder, input);
}

type StellarSdk = typeof import("@stellar/stellar-sdk");

function toSdkAsset(stellar: StellarSdk, ref: AssetRef): Asset {
  return ref.issuer === null ? stellar.Asset.native() : new stellar.Asset(ref.code, ref.issuer);
}

function finish(
  stellar: StellarSdk,
  builder: InstanceType<StellarSdk["TransactionBuilder"]>,
  input: BuildPaymentXdrInput,
): string {
  const withMemo = input.memo ? builder.addMemo(stellar.Memo.text(input.memo)) : builder;
  return withMemo.setTimeout(300).build().toXDR();
}

function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.code === b.code && (a.issuer ?? null) === (b.issuer ?? null);
}

/** 1% of the destination amount, exactly, and never less than one stroop. */
function onePercentOf(amount: string): string {
  const stroops = toStroops(amount);
  const slice = stroops / 100n;
  return fromStroops(slice > 0n ? slice : 1n);
}
