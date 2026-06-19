import { StrKey } from "@stellar/stellar-sdk";
import type { AssetRef, PaymentRequest, RailPort } from "@checkout/core";
import { buildSep7PayUri } from "@checkout/core";
import type { StellarConfig } from "./asset";

/** Non-custodial settlement rail: the payer pays the seller's wallet directly,
 *  with the link reference carried as the MEMO_TEXT so we can correlate it. */
export class StellarRail implements RailPort {
  constructor(private readonly cfg: StellarConfig) {}

  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    message?: string;
  }): PaymentRequest {
    const uri = buildSep7PayUri({
      destination: input.destination,
      amount: input.amount,
      asset: input.asset,
      memo: input.reference,
      memoType: "MEMO_TEXT",
      message: input.message,
      networkPassphrase: this.cfg.networkPassphrase,
    });
    return {
      uri,
      destination: input.destination,
      amount: input.amount,
      asset: input.asset,
      memo: input.reference,
    };
  }

  isValidDestination(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }
}
