import { toStroops, type LinkRefundSummary, type PaymentLink } from "@checkout/core";
import { PAID_STATUSES } from "./dashboard-metrics";

/** The fields the dashboard needs to decide whether a Refund action is useful. */
export interface RefundableLink {
  status: PaymentLink["status"];
  paidAmount: string | null;
  /** Present once the API exposes refund totals (issue 5.45). */
  refundSummary?: LinkRefundSummary | null;
}

/**
 * Whether a link still has money that can be refunded.
 *
 * Without a summary the dashboard can only know that a paid link received
 * something, so it offers the action and the sheet's own preflight is the
 * final check. With a summary (the link detail response, and later the list),
 * confirmed and pending refunds are subtracted in stroops.
 */
export function hasRefundableAmount(link: RefundableLink, summary?: LinkRefundSummary | null): boolean {
  if (!PAID_STATUSES.has(link.status)) return false;
  if (!link.paidAmount) return false;
  const paid = toStroops(link.paidAmount);
  if (paid <= 0n) return false;

  const totals = summary ?? link.refundSummary ?? null;
  if (!totals) return true;
  if (totals.fullyRefunded) return false;
  const reserved = toStroops(totals.refundedAmount) + toStroops(totals.pendingAmount);
  return paid - reserved > 0n;
}
