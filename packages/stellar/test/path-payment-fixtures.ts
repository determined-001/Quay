import type { HorizonPaymentRecord } from "../src/horizon-client";
import strictReceive from "./fixtures/path-payment-strict-receive.json";
import strictSend from "./fixtures/path-payment-strict-send.json";

/**
 * Real testnet path payment records — see `fixtures/README.md` for where each
 * one came from. Horizon reports the delivered (destination) side in
 * `amount`/`asset_*` and the paid side in `source_amount`/`source_asset_*`;
 * in both fixtures the two differ, so settling on the wrong side fails loudly.
 */
export type PathPaymentFixture = typeof strictReceive | typeof strictSend;

export const strictReceiveFixture: PathPaymentFixture = strictReceive;
export const strictSendFixture: PathPaymentFixture = strictSend;

/**
 * Shapes a JSON fixture like the record the watchers consume. With
 * `join=transactions` Horizon embeds the transaction as data; the SDK exposes it
 * as the `transaction()` method the normalizer calls.
 */
export function asHorizonRecord(fixture: PathPaymentFixture): HorizonPaymentRecord {
  return {
    ...fixture,
    transaction: async () => fixture.transaction,
  } as unknown as HorizonPaymentRecord;
}
