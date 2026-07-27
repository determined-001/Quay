import type { AssetRef, PaymentLink } from "../domain/payment-link";
import { assetEquals, isNative } from "../domain/payment-link";
import { compareAmount, fromStroops, toStroops } from "../domain/money";

// A Horizon payment, normalized into the shape the matcher needs.
// (The Stellar adapter is responsible for producing this from a raw Horizon record.)
export interface NormalizedPayment {
  txHash: string;
  pagingToken: string;
  from: string;
  to: string; // destination account the value landed in
  amount: string; // delivered amount, decimal string
  asset: AssetRef;
  memo: string | null; // transaction memo (correlation id), if any
  memoType: string | null; // "text" | "id" | "hash" | "none" | ...
  createdAt: string;
}

export type MatchOutcome =
  | {
      kind: "paid";
      link: PaymentLink;
      overpaid: boolean;
      receivedTotal: string;
      outstanding: string;
    }
  | {
      kind: "partial";
      link: PaymentLink;
      receivedTotal: string;
      outstanding: string;
    }
  | { kind: "asset_mismatch"; link: PaymentLink }
  | { kind: "no_memo" }
  | { kind: "unknown_reference" };

/**
 * Match a single incoming payment against the link identified by its memo.
 *
 * `findLinkByReference` is injected (the adapter/service supplies a lookup),
 * keeping this function pure and unit-testable with no I/O.
 */
export function matchPayment(
  payment: NormalizedPayment,
  findLinkByReference: (reference: string) => PaymentLink | undefined,
  alreadyPaidStroops: bigint = 0n,
): MatchOutcome {
  // Correlation is via MEMO_TEXT carrying the link reference.
  if (!payment.memo || payment.memoType === "none") {
    return { kind: "no_memo" };
  }

  const link = findLinkByReference(payment.memo);
  if (!link) {
    return { kind: "unknown_reference" };
  }

  // Defense in depth: the value must actually be addressed to the link's destination.
  if (payment.to !== link.destination) {
    return { kind: "unknown_reference" };
  }

  if (!assetMatches(payment.asset, link.asset)) {
    return { kind: "asset_mismatch", link };
  }

  const requested = toStroops(link.amount);
  const outstandingStroops =
    requested > alreadyPaidStroops ? requested - alreadyPaidStroops : 0n;
  const outstanding = fromStroops(outstandingStroops);
  const receivedTotal = normalizeAmount(payment.amount);
  const cmp = compareAmount(payment.amount, outstanding);
  if (cmp === "under") {
    return { kind: "partial", link, receivedTotal, outstanding };
  }
  return {
    kind: "paid",
    link,
    overpaid: cmp === "over",
    receivedTotal,
    outstanding,
  };
}

function assetMatches(received: AssetRef, expected: AssetRef): boolean {
  // Native is compared by code only; issued assets by code + issuer.
  if (isNative(expected)) return isNative(received);
  return assetEquals(received, expected);
}
