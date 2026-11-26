// Where a refund of one payment should be sent, and whether the seller has to
// add something before it can be (issue 2.14).
//
// `link_payments.payer` alone is not enough. Sending a refund to the wrong
// place is permanent, and the plain G-address is the wrong place in two cases:
//
//  - The payer sent from an M-address (SEP-23). A custodial wallet or an
//    exchange does that to say which of its customers paid. The refund goes
//    back to the same M-address, or the custodian cannot credit it.
//  - The payer's account asks for a memo on everything it receives (SEP-29,
//    the `config.memo_required` data entry). That is usually an exchange hot
//    wallet that did not say who its customer was. Only the buyer knows the
//    deposit memo, so the seller has to type it.

/** The data entry SEP-29 defines, and the value that switches it on. */
export const MEMO_REQUIRED_DATA_KEY = "config.memo_required";
const MEMO_REQUIRED_VALUE = "1";

/** What is needed of the payment: the payer as `link_payments` stores it. */
export interface RefundablePayment {
  payer: string;
  payerMuxed?: string | null;
}

/**
 * What is needed of the payer's account: its data entries as the SDK's
 * `loadAccount` returns them, in `data_attr`, with base64 values.
 */
export interface RefundAccountInfo {
  data_attr?: Record<string, string>;
}

export type RefundDestination =
  /** Send it to `destination`; nothing more is needed. */
  | { kind: "ready"; destination: string }
  /** `destination` is right, but the account requires a memo the seller must supply. */
  | { kind: "needs_memo"; destination: string }
  /** The payer's account no longer exists (it was merged), so nothing can be sent to it. */
  | { kind: "account_gone" };

/** Whether an account's data entries carry SEP-29's `config.memo_required` = "1". */
export function accountRequiresMemo(account: RefundAccountInfo): boolean {
  const raw = account.data_attr?.[MEMO_REQUIRED_DATA_KEY];
  if (typeof raw !== "string") return false;
  // Horizon returns data values base64-encoded; "1" arrives as "MQ==".
  return Buffer.from(raw, "base64").toString("utf8") === MEMO_REQUIRED_VALUE;
}

/**
 * Pure: `accountInfo` is the payer's account as `loadAccount` returned it, or
 * null when Horizon answered that there is no such account.
 *
 * A payment from an M-address is `ready` even when the account requires a
 * memo. The muxed id already names the customer, which is what the memo is
 * for, and SEP-29 exempts a muxed destination from the check for that reason.
 */
export function resolveRefundDestination(
  payment: RefundablePayment,
  accountInfo: RefundAccountInfo | null,
): RefundDestination {
  if (accountInfo === null) return { kind: "account_gone" };
  if (payment.payerMuxed) return { kind: "ready", destination: payment.payerMuxed };
  if (accountRequiresMemo(accountInfo)) return { kind: "needs_memo", destination: payment.payer };
  return { kind: "ready", destination: payment.payer };
}
