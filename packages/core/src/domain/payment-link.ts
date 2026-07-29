import type { LinkStatus } from "./status";

/** A reference to a Stellar asset. `null` issuer means native XLM. */
export interface AssetRef {
  code: string; // "USDC" or "XLM"
  issuer: string | null; // G... issuer, or null for native
}

export const XLM: AssetRef = { code: "XLM", issuer: null };

export function isNative(asset: AssetRef): boolean {
  return asset.issuer === null;
}

export function assetEquals(a: AssetRef, b: AssetRef): boolean {
  if (isNative(a) || isNative(b)) {
    return isNative(a) && isNative(b) && a.code === b.code;
  }
  return a.code === b.code && a.issuer === b.issuer;
}

export interface PaymentLink {
  id: string; // public id, used in the checkout URL (/pay/:id)
  reference: string; // short, <=28 bytes — embedded as the Stellar MEMO_TEXT
  sellerId: string;
  destination: string; // seller's G-address (payments land here, non-custodial)
  title: string;
  amount: string; // requested amount, canonical decimal string
  asset: AssetRef;
  status: LinkStatus;
  // settlement (filled when paid)
  txHash: string | null;
  payer: string | null;
  paidAmount: string | null;
  // off-ramp (filled when the seller cashes out)
  offrampJobId: string | null;
  offrampTargetCurrency: string | null;
  offrampStatus: string | null;
  expiresAt: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
}

/**
 * The subset of a `PaymentLink` a buyer is allowed to see (issue 6.4).
 * `GET /links/:id` is intentionally public - a payment link only works if the
 * person paying it can view it without a seller credential - but "public"
 * does not mean "the full internal record." No `sellerId`, `destination`
 * (the actual pay-to address travels separately, in the `PaymentRequest`
 * built alongside this), off-ramp bookkeeping, or timestamps a buyer has no
 * legitimate use for.
 */
export interface PublicPaymentLink {
  id: string;
  reference: string;
  title: string;
  amount: string;
  asset: AssetRef;
  status: LinkStatus;
  paidAmount: string | null;
  txHash: string | null;
}

export function toPublicPaymentLink(link: PaymentLink): PublicPaymentLink {
  return {
    id: link.id,
    reference: link.reference,
    title: link.title,
    amount: link.amount,
    asset: link.asset,
    status: link.status,
    paidAmount: link.paidAmount,
    txHash: link.txHash,
  };
}
