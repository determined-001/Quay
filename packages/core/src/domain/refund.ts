// Refunds: money a seller sends back to someone who paid one of their links.
//
// A refund belongs to a payment, not to a link. A link can be paid by several
// payers in several operations (split payments and top-ups, issue 1.4), each
// recorded as its own `LinkPaymentRecord`, so "refund this link" does not say
// whose money goes back. Every refund names the payment operation it returns,
// by `paymentTxHash` + `paymentOperationId`, and is capped by that payment.
//
// There are no refund states in `LINK_STATUSES` (status.ts), on purpose:
//
//  - The link's machine describes a buyer paying and a seller cashing out.
//    `paid` leads only to `offramp_pending`, and `offramp_settled`, `expired`
//    and `cancelled` are terminal. A seller may have to refund at any of
//    those points, also after a cash-out has settled, so a refund is not a
//    step on that path. A `refunded` link status would have to be reachable
//    from terminal states, and it would overwrite whether the link had been
//    cashed out.
//  - A refund is often partial (the overpaid part of a payment is the most
//    common case), and one link can have several, in different states at the
//    same moment. One status field on the link cannot say that.
//
// So a refund has its own small machine, below, and what a link shows about
// its refunds ("Refunded", "Part refunded") is worked out from the refunds
// by `linkRefundSummary`. `LinkStatus` stays as it is.

import { fromStroops, isPositiveAmount, STELLAR_DECIMALS, toStroops } from "./money";
import type { AssetRef } from "./payment-link";

export const REFUND_STATUSES = [
  "prepared", // an unsigned transaction was built for the seller to sign
  "submitted", // Horizon accepted the signed transaction; its hash is known
  "confirmed", // the refund is on the ledger
  "failed", // it never got there: its time bounds passed unsigned, or the transaction failed
] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  // Signed and accepted, or its time bounds passed before it was.
  prepared: ["submitted", "failed"],
  submitted: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
};

export function canTransitionRefund(from: RefundStatus, to: RefundStatus): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!canTransitionRefund(from, to)) {
    throw new Error(`Illegal refund status transition: ${from} -> ${to}`);
  }
}

export function isRefundTerminal(status: RefundStatus): boolean {
  return REFUND_TRANSITIONS[status].length === 0;
}

/** How the refund transaction's memo is encoded, when it carries one. */
export type RefundMemoType = "text" | "id" | "hash";

export interface Refund {
  id: string;
  linkId: string;
  sellerId: string;
  /** The payment this refund returns: `LinkPaymentRecord.txHash`... */
  paymentTxHash: string;
  /** ...and `LinkPaymentRecord.operationId`. One transaction can carry more
   *  than one payment to a link, so the hash alone does not name a payment. */
  paymentOperationId: string;
  /** G-address the refund is sent to. */
  destination: string;
  /** SEP-23 muxed id when the refund goes to a muxed account of `destination`. */
  destinationMuxedId: string | null;
  /** Memo the destination needs to credit the refund, such as an exchange's
   *  deposit memo. `memoType` says how to encode it; both are null together. */
  memo: string | null;
  memoType: RefundMemoType | null;
  /** Amount sent back, a canonical decimal string in `asset`. */
  amount: string;
  asset: AssetRef;
  status: RefundStatus;
  /** Hash of the refund transaction; null while the refund is `prepared`. */
  txHash: string | null;
  /** Why the refund failed; null unless it is `failed`. */
  failureReason: string | null;
  createdAt: number; // epoch ms
  updatedAt: number;
}

/**
 * How much of one payment can still be refunded: the payment's amount minus
 * every refund of it that has not failed, in stroops, never below zero.
 *
 * A `prepared` refund counts although no money has moved yet. Otherwise two
 * refund sheets opened at the same time would each be offered the whole
 * amount, and both could be signed. (The API makes that reservation atomic in
 * 4.62; this is the arithmetic it shares with the web.)
 *
 * `refunds` must be the refunds of this one payment.
 */
export function refundableAmount(
  paymentAmount: string,
  refunds: ReadonlyArray<Pick<Refund, "amount" | "status">>,
): string {
  let left = toStroops(paymentAmount);
  for (const refund of refunds) {
    if (refund.status === "failed") continue;
    left -= toStroops(refund.amount);
  }
  return fromStroops(left > 0n ? left : 0n);
}

export type RefundAmountRejection =
  | "invalid_amount" // not a decimal number
  | "not_positive" // zero or negative
  | "too_many_decimals" // more than 7, so not a whole number of stroops
  | "exceeds_refundable"; // more than the payment has left

export type RefundAmountValidation = { ok: true } | { ok: false; reason: RefundAmountRejection };

const rejected = (reason: RefundAmountRejection): RefundAmountValidation => ({ ok: false, reason });

// A decimal number, to tell a number that breaks a rule from text that is
// not a number at all: an optional minus sign, digits, optional decimals.
const DECIMAL_RE = /^(-?)\d+(?:\.(\d+))?$/;

/**
 * Checks the amount a seller asks to refund against what its payment has
 * left, which is `refundableAmount`'s answer. The two are compared in
 * stroops, never as floats or as strings. A `refundable` that is not a
 * Stellar amount is a programming error and throws.
 */
export function validateRefundAmount(requested: string, refundable: string): RefundAmountValidation {
  const limit = toStroops(refundable);
  const amount = requested.trim();
  const shape = DECIMAL_RE.exec(amount);
  if (!shape) return rejected("invalid_amount");
  if (shape[1] === "-") return rejected("not_positive");
  if ((shape[2] ?? "").length > STELLAR_DECIMALS) return rejected("too_many_decimals");

  // From here `amount` is a well-formed Stellar amount, so toStroops accepts it.
  const stroops = toStroops(amount);
  if (stroops === 0n) return rejected("not_positive");
  // isPositiveAmount also refuses more than an account can hold, which is
  // more than any payment has left.
  if (!isPositiveAmount(amount) || stroops > limit) return rejected("exceeds_refundable");
  return { ok: true };
}

/** The part of a recorded payment (`LinkPaymentRecord`) the refund rules read. */
export interface RefundablePayment {
  txHash: string;
  operationId: string;
  amount: string;
}

export interface LinkRefundSummary {
  /** Total of the refunds that are on the ledger (`confirmed`). */
  refundedAmount: string;
  /** Total of the refunds on their way: `prepared` or `submitted`. */
  pendingAmount: string;
  /** Every payment the link received has been refunded in full by confirmed
   *  refunds. False for a link nobody has paid. */
  fullyRefunded: boolean;
}

const paymentKey = (txHash: string, operationId: string): string => `${txHash}:${operationId}`;

/**
 * What a link can say about its refunds without a status of its own: the web
 * shows "Refunded" when `fullyRefunded`, and "Part refunded" when something
 * was refunded but not everything. Amounts are in the link's asset, which is
 * the asset of every payment recorded against it. Failed refunds count
 * nowhere.
 *
 * `fullyRefunded` is decided payment by payment, because that is how refunds
 * are capped: totals that happen to match do not make a link refunded if one
 * of its payers got nothing back.
 */
export function linkRefundSummary(
  payments: ReadonlyArray<RefundablePayment>,
  refunds: ReadonlyArray<Pick<Refund, "paymentTxHash" | "paymentOperationId" | "amount" | "status">>,
): LinkRefundSummary {
  let refunded = 0n;
  let pending = 0n;
  const confirmedByPayment = new Map<string, bigint>();
  for (const refund of refunds) {
    if (refund.status === "failed") continue;
    const stroops = toStroops(refund.amount);
    if (refund.status === "confirmed") {
      refunded += stroops;
      const key = paymentKey(refund.paymentTxHash, refund.paymentOperationId);
      confirmedByPayment.set(key, (confirmedByPayment.get(key) ?? 0n) + stroops);
    } else {
      pending += stroops;
    }
  }
  const fullyRefunded =
    payments.length > 0 &&
    payments.every(
      (payment) =>
        (confirmedByPayment.get(paymentKey(payment.txHash, payment.operationId)) ?? 0n) >=
        toStroops(payment.amount),
    );
  return {
    refundedAmount: fromStroops(refunded),
    pendingAmount: fromStroops(pending),
    fullyRefunded,
  };
}
