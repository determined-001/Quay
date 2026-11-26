import { afterEach, describe, expect, it, vi } from "vitest";
import * as stellar from "@stellar/stellar-sdk";
import type { PayOption } from "../lib/api";
import {
  PLAIN_PAYMENT_TIMEOUT_SECONDS,
  buildPaymentTransaction,
  isPathOption,
  type PaymentTransactionInput,
} from "../lib/payment-transaction";

// ---------------------------------------------------------------------------
//  The transaction a buyer's wallet signs (issue 5.48), built with the real
//  SDK and read back from its XDR. `wallet-pay-button.test.tsx` covers the
//  button around it with the SDK mocked.
// ---------------------------------------------------------------------------

const PASSPHRASE = stellar.Networks.TESTNET;
const BUYER = stellar.Keypair.random().publicKey();
const SELLER = stellar.Keypair.random().publicKey();
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EURC_ISSUER = stellar.Keypair.random().publicKey();
const USDC = { code: "USDC", issuer: ISSUER };
const XLM = { code: "XLM", issuer: null };
const EURC = { code: "EURC", issuer: EURC_ISSUER };
const EXPIRES_AT = 1_763_560_030_500;

const option = (over: Partial<PayOption> = {}): PayOption => ({
  sourceAsset: XLM,
  sourceAmount: "24.1234567",
  sendMax: "24.3646913",
  path: [],
  quotedAt: EXPIRES_AT - 30_000,
  expiresAt: EXPIRES_AT,
  ...over,
});

const input = (over: Partial<PaymentTransactionInput> = {}): PaymentTransactionInput => ({
  source: { address: BUYER, sequence: "100" },
  networkPassphrase: PASSPHRASE,
  feeStroops: 100n,
  destination: SELLER,
  asset: USDC,
  amount: "10",
  memo: "ref_1",
  ...over,
});

const read = (xdr: string) => new stellar.Transaction(xdr, PASSPHRASE);
const assetOf = (asset: stellar.Asset) => (asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("buildPaymentTransaction — paying with another asset", () => {
  it("builds one strict-receive path payment that matches the option", () => {
    const tx = read(buildPaymentTransaction(stellar, input({ option: option({ path: [EURC] }) })));

    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as stellar.Operation.PathPaymentStrictReceive;
    expect(op.type).toBe("pathPaymentStrictReceive");
    // The source side is the option's.
    expect(assetOf(op.sendAsset)).toBe("native");
    expect(op.sendMax).toBe("24.3646913");
    expect(op.path.map(assetOf)).toEqual([`EURC:${EURC_ISSUER}`]);
    // The destination side is the link's: exactly the amount it still owes.
    expect(op.destination).toBe(SELLER);
    expect(assetOf(op.destAsset)).toBe(`USDC:${ISSUER}`);
    expect(op.destAmount).toBe("10.0000000");
    // No operation-level source: the server refuses one.
    expect(op.source).toBeUndefined();

    expect([tx.memo.type, tx.memo.value?.toString()]).toEqual(["text", "ref_1"]);
    expect(tx.source).toBe(BUYER);
    expect(tx.sequence).toBe("101");
    expect(tx.fee).toBe("100");
  });

  it("expires with the quote, to the second, whatever the buyer's clock says", () => {
    const expected = { minTime: "0", maxTime: String(Math.floor(EXPIRES_AT / 1000)) };
    expect(read(buildPaymentTransaction(stellar, input({ option: option() }))).timeBounds).toEqual(expected);

    // A clock an hour fast, and one a day slow: the same transaction, byte for byte.
    const atRealTime = buildPaymentTransaction(stellar, input({ option: option() }));
    vi.useFakeTimers();
    for (const skewMs of [3_600_000, -86_400_000]) {
      vi.setSystemTime(EXPIRES_AT + skewMs);
      expect(buildPaymentTransaction(stellar, input({ option: option() }))).toBe(atRealTime);
    }
  });

  it("pays from an issued asset through several hops", () => {
    const hops = [XLM, { code: "AQUA", issuer: EURC_ISSUER }];
    const tx = read(
      buildPaymentTransaction(stellar, input({ option: option({ sourceAsset: EURC, sendMax: "9.3", path: hops }) })),
    );
    const op = tx.operations[0] as stellar.Operation.PathPaymentStrictReceive;
    expect(assetOf(op.sendAsset)).toBe(`EURC:${EURC_ISSUER}`);
    expect(op.sendMax).toBe("9.3000000");
    expect(op.path.map(assetOf)).toEqual(["native", `AQUA:${EURC_ISSUER}`]);
  });

  it("keeps a muxed destination, and sends no memo when the link has none", () => {
    const muxed = new stellar.MuxedAccount(new stellar.Account(SELLER, "0"), "4242").accountId();
    expect(muxed.startsWith("M")).toBe(true);
    const tx = read(buildPaymentTransaction(stellar, input({ destination: muxed, memo: null, option: option() })));
    const op = tx.operations[0] as stellar.Operation.PathPaymentStrictReceive;
    expect(op.destination).toBe(muxed);
    expect(tx.memo.type).toBe("none");
  });

  it("delivers only what an underpaid link still owes", () => {
    const tx = read(buildPaymentTransaction(stellar, input({ amount: "5.75", option: option({ sendMax: "14" }) })));
    expect((tx.operations[0] as stellar.Operation.PathPaymentStrictReceive).destAmount).toBe("5.7500000");
  });
});

describe("buildPaymentTransaction — paying with the link's own asset", () => {
  /** The transaction as `WalletPayButton` built it inline before issue 5.48. */
  function before(memo: string | null, destination = SELLER): string {
    const builder = new stellar.TransactionBuilder(new stellar.Account(BUYER, "100"), {
      fee: "100",
      networkPassphrase: PASSPHRASE,
    }).addOperation(
      stellar.Operation.payment({
        destination,
        asset: new stellar.Asset("USDC", ISSUER),
        amount: "10",
      }),
    );
    if (memo) builder.addMemo(stellar.Memo.text(memo));
    return builder.setTimeout(300).build().toXDR();
  }

  it("builds the same transaction as before, byte for byte", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    expect(PLAIN_PAYMENT_TIMEOUT_SECONDS).toBe(300);
    expect(buildPaymentTransaction(stellar, input())).toBe(before("ref_1"));
    expect(buildPaymentTransaction(stellar, input({ option: null }))).toBe(before("ref_1"));
    expect(buildPaymentTransaction(stellar, input({ memo: null }))).toBe(before(null));

    const muxed = new stellar.MuxedAccount(new stellar.Account(SELLER, "0"), "7").accountId();
    expect(buildPaymentTransaction(stellar, input({ destination: muxed, memo: null }))).toBe(before(null, muxed));
  });

  it("is a plain payment when the chosen option is in the link's own asset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const own = option({ sourceAsset: USDC, sourceAmount: "10", sendMax: "10.1" });
    expect(buildPaymentTransaction(stellar, input({ option: own }))).toBe(before("ref_1"));
    expect(read(buildPaymentTransaction(stellar, input({ option: own }))).operations[0]!.type).toBe("payment");
  });

  it("pays a native link with a payment, not a path", () => {
    const tx = read(buildPaymentTransaction(stellar, input({ asset: XLM, option: option() })));
    const op = tx.operations[0] as stellar.Operation.Payment;
    expect(op.type).toBe("payment");
    expect(op.asset.isNative()).toBe(true);
  });
});

describe("isPathOption", () => {
  it("is true only for an option in another asset than the link's", () => {
    expect(isPathOption(option(), USDC)).toBe(true);
    expect(isPathOption(option({ sourceAsset: EURC }), USDC)).toBe(true);
    // The same code under another issuer is another asset.
    expect(isPathOption(option({ sourceAsset: { code: "USDC", issuer: EURC_ISSUER } }), USDC)).toBe(true);
    expect(isPathOption(option({ sourceAsset: USDC }), USDC)).toBe(false);
    expect(isPathOption(option({ sourceAsset: XLM }), XLM)).toBe(false);
    expect(isPathOption(null, USDC)).toBe(false);
    expect(isPathOption(undefined, USDC)).toBe(false);
  });
});
