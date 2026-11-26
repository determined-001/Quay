import type { AssetRef } from "@checkout/core";
import type { PayOption } from "./api";

type StellarSdk = typeof import("@stellar/stellar-sdk");

/** How long a plain payment stays valid once built, in seconds. */
export const PLAIN_PAYMENT_TIMEOUT_SECONDS = 300;

export interface PaymentTransactionInput {
  /** The buyer's account and its current sequence number, as Horizon reports it. */
  source: { address: string; sequence: string };
  networkPassphrase: string;
  feeStroops: bigint;
  /** Where the link is paid: a G-address, or an M-address for a muxed link. */
  destination: string;
  /** The asset the link asks for. */
  asset: AssetRef;
  /** What the link still owes, in `asset`. */
  amount: string;
  /** The link's reference, carried as a text memo. Absent for a muxed link. */
  memo?: string | null;
  /**
   * The way the buyer chose to pay with another asset (issue 5.48). Absent, or
   * in the link's own asset, the transaction is a plain payment.
   */
  option?: PayOption | null;
}

function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.code === b.code && a.issuer === b.issuer;
}

/** Whether `option` pays with another asset than the link's, and so needs a path payment. */
export function isPathOption(option: PayOption | null | undefined, linkAsset: AssetRef): option is PayOption {
  return option != null && !sameAsset(option.sourceAsset, linkAsset);
}

/**
 * The unsigned transaction a buyer's wallet signs to pay a link, as XDR.
 *
 * Paying with the link's own asset it is one `payment`, exactly as before
 * path payments existed.
 *
 * Paying with another asset it is one `path_payment_strict_receive` (issue
 * 5.48). It delivers exactly `amount` of the link's asset, never spends more
 * than the option's `sendMax`, and goes through the option's `path`. It stops
 * being valid when the quote does: `maxTime` is the quote's `expiresAt`, which
 * came from the server, so the buyer's own clock does not enter into it and
 * the transaction cannot land later at a worse price. The memo and the
 * destination are the plain payment's.
 *
 * Pure: the SDK is passed in, because the checkout loads it only once the
 * buyer chooses to pay from a wallet.
 */
export function buildPaymentTransaction(stellar: StellarSdk, input: PaymentTransactionInput): string {
  const toAsset = (ref: AssetRef) =>
    ref.issuer === null ? stellar.Asset.native() : new stellar.Asset(ref.code, ref.issuer);
  const source = new stellar.Account(input.source.address, input.source.sequence);
  const fee = String(input.feeStroops);

  if (!isPathOption(input.option, input.asset)) {
    const builder = new stellar.TransactionBuilder(source, {
      fee,
      networkPassphrase: input.networkPassphrase,
    }).addOperation(
      stellar.Operation.payment({
        destination: input.destination,
        asset: toAsset(input.asset),
        amount: input.amount,
      }),
    );
    if (input.memo) builder.addMemo(stellar.Memo.text(input.memo));
    return builder.setTimeout(PLAIN_PAYMENT_TIMEOUT_SECONDS).build().toXDR();
  }

  const option = input.option;
  const builder = new stellar.TransactionBuilder(source, {
    fee,
    networkPassphrase: input.networkPassphrase,
    timebounds: { minTime: 0, maxTime: Math.floor(option.expiresAt / 1000) },
  }).addOperation(
    stellar.Operation.pathPaymentStrictReceive({
      sendAsset: toAsset(option.sourceAsset),
      sendMax: option.sendMax,
      destination: input.destination,
      destAsset: toAsset(input.asset),
      destAmount: input.amount,
      path: option.path.map(toAsset),
    }),
  );
  if (input.memo) builder.addMemo(stellar.Memo.text(input.memo));
  return builder.build().toXDR();
}
