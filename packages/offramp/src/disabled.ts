import {
  OffRampDisabledError,
  type AssetRef,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type PayoutFieldDescriptor,
  type SellerPayoutRef,
} from "@checkout/core";

// ===========================================================================
//  NO OFF-RAMP — OFFRAMP=none
// ===========================================================================
// A deployment that takes payments and stops there. Buyers pay the seller's
// own wallet directly, the watcher confirms it on the ledger, and the seller
// moves their funds themselves. There is no cash-out leg.
//
// This exists rather than making `OffRampPort` optional throughout LinkService
// because the alternative is a nullable dependency threaded through every
// call site, each with its own idea of what "off-ramp missing" means. One
// adapter that refuses loudly keeps the seam intact: re-enabling cash-out is a
// change of environment variable, not a change of shape.
//
// It also removes real risk on mainnet. `DEFAULT_SELLER_SECRET` is required
// only to sign SEP-10 auth for a real anchor, so with the off-ramp disabled the
// server holds no key that can spend a seller's funds at all.

export class DisabledOffRamp implements OffRampPort {
  // The mode a seller-facing surface would have had. Kept accurate rather than
  // inventing a "disabled" mode: the routes never get far enough to read it,
  // and telemetry rows that predate the switch still say seller_initiated.
  readonly mode: OffRampMode = "seller_initiated";

  async quote(_input: {
    linkId: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    throw new OffRampDisabledError("quote");
  }

  async initiate(_input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampInitiation> {
    throw new OffRampDisabledError("initiate");
  }

  async status(_jobId: string): Promise<OffRampJob> {
    throw new OffRampDisabledError("status");
  }

  async offrampRequirements(_assetCode: string): Promise<PayoutFieldDescriptor[]> {
    throw new OffRampDisabledError("offrampRequirements");
  }

  // `indicativePrices` is deliberately NOT implemented. It is optional on the
  // port, and LinkService already treats its absence as "this adapter cannot
  // quote indicatively" and degrades to an empty price list — which is exactly
  // right here, and gives the dashboard a graceful surface instead of an error.
}
