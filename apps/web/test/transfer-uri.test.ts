import { describe, expect, it } from "vitest";
import type { WithdrawTransfer } from "@checkout/core";
import {
  buildTransferUri,
  hashMemoToBase64,
  paymentMatchesTransfer,
  toSep7Memo,
  transferDetails,
  transferDetailsText,
  TransferUriError,
} from "../lib/transfer-uri";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const TESTNET = "Test SDF Network ; September 2015";
const USDC = { code: "USDC", issuer: ISSUER };

// 32 bytes 0x00..0x1f
const HASH_HEX = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("");
const HASH_B64 = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

function transfer(over: Partial<WithdrawTransfer> = {}): WithdrawTransfer {
  return { destination: DEST, amount: "25.5", asset: USDC, memo: "abc123", memoType: "text", ...over };
}

function params(uri: string): URLSearchParams {
  expect(uri.startsWith("web+stellar:pay?")).toBe(true);
  return new URLSearchParams(uri.slice("web+stellar:pay?".length));
}

describe("buildTransferUri", () => {
  it("builds an issued-asset text-memo URI with every field and the network", () => {
    const p = params(buildTransferUri(transfer(), TESTNET));
    expect(p.get("destination")).toBe(DEST);
    expect(p.get("amount")).toBe("25.5");
    expect(p.get("asset_code")).toBe("USDC");
    expect(p.get("asset_issuer")).toBe(ISSUER);
    expect(p.get("memo")).toBe("abc123");
    expect(p.get("memo_type")).toBe("MEMO_TEXT");
    expect(p.get("msg")).toBe("Quay cash-out");
    expect(p.get("network_passphrase")).toBe(TESTNET);
  });

  it("omits the asset params for native XLM", () => {
    const p = params(buildTransferUri(transfer({ asset: { code: "XLM", issuer: null } }), TESTNET));
    expect(p.has("asset_code")).toBe(false);
    expect(p.has("asset_issuer")).toBe(false);
  });

  it("treats a missing memo type as text", () => {
    const p = params(buildTransferUri(transfer({ memoType: null }), TESTNET));
    expect(p.get("memo_type")).toBe("MEMO_TEXT");
  });

  it("omits memo params when the anchor sent no memo", () => {
    const p = params(buildTransferUri(transfer({ memo: null, memoType: null }), TESTNET));
    expect(p.has("memo")).toBe(false);
    expect(p.has("memo_type")).toBe(false);
  });

  it("maps an id memo to MEMO_ID", () => {
    const p = params(buildTransferUri(transfer({ memo: "18446744073709551615", memoType: "id" }), TESTNET));
    expect(p.get("memo")).toBe("18446744073709551615");
    expect(p.get("memo_type")).toBe("MEMO_ID");
  });

  it("maps a base64 hash memo to MEMO_HASH and round-trips the bytes", () => {
    const uri = buildTransferUri(transfer({ memo: HASH_B64, memoType: "hash" }), TESTNET);
    const p = params(uri);
    expect(p.get("memo_type")).toBe("MEMO_HASH");
    expect(p.get("memo")).toBe(HASH_B64);
    // '+', '/' and '=' must be percent-encoded in the raw URI, not left bare.
    expect(uri).not.toMatch(/memo=[^&]*[+/=][^&]*&/);
  });

  it("re-encodes a hex hash memo as base64 for SEP-7", () => {
    const p = params(buildTransferUri(transfer({ memo: HASH_HEX, memoType: "hash" }), TESTNET));
    expect(p.get("memo")).toBe(HASH_B64);
  });

  it("errors on an over-long text memo instead of truncating", () => {
    const long = "x".repeat(29);
    expect(() => buildTransferUri(transfer({ memo: long }), TESTNET)).toThrow(TransferUriError);
    expect(() => buildTransferUri(transfer({ memo: long }), TESTNET)).toThrow(/29 bytes/);
  });

  it("counts text memo length in bytes, not characters", () => {
    expect(() => buildTransferUri(transfer({ memo: "é".repeat(14) }), TESTNET)).not.toThrow();
    expect(() => buildTransferUri(transfer({ memo: "é".repeat(15) }), TESTNET)).toThrow(TransferUriError);
  });

  it("rejects malformed id and hash memos", () => {
    expect(() => toSep7Memo({ memo: "12a", memoType: "id" })).toThrow(TransferUriError);
    expect(() => toSep7Memo({ memo: "18446744073709551616", memoType: "id" })).toThrow(TransferUriError);
    expect(() => hashMemoToBase64("AAAA")).toThrow(TransferUriError);
    expect(() => hashMemoToBase64("not base64!")).toThrow(TransferUriError);
  });

  it("wraps a bad destination in TransferUriError", () => {
    expect(() => buildTransferUri(transfer({ destination: "nope" }), TESTNET)).toThrow(TransferUriError);
  });
});

describe("transferDetails", () => {
  it("lists destination, amount, asset, memo and memo type", () => {
    const text = transferDetailsText(transfer({ memo: HASH_HEX, memoType: "hash" }));
    expect(text).toContain(`Destination: ${DEST}`);
    expect(text).toContain("Amount: 25.5");
    expect(text).toContain("Asset: USDC");
    expect(text).toContain(`Asset issuer: ${ISSUER}`);
    expect(text).toContain(`Memo: ${HASH_B64}`);
    expect(text).toContain("Memo type: MEMO_HASH");
  });

  it("has no issuer or memo rows for native XLM without a memo", () => {
    const labels = transferDetails(transfer({ asset: { code: "XLM", issuer: null }, memo: null, memoType: null })).map(
      (d) => d.label,
    );
    expect(labels).toEqual(["Destination", "Amount", "Asset"]);
  });
});

describe("paymentMatchesTransfer", () => {
  const payment = { type: "payment", to: DEST, amount: "25.5000000", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER };

  it("matches destination, asset, amount (ignoring trailing zeros) and text memo", () => {
    expect(paymentMatchesTransfer(payment, { memo_type: "text", memo: "abc123" }, transfer())).toBe(true);
  });

  it("matches id and hash memos", () => {
    expect(paymentMatchesTransfer(payment, { memo_type: "id", memo: "42" }, transfer({ memo: "42", memoType: "id" }))).toBe(true);
    expect(
      paymentMatchesTransfer(payment, { memo_type: "hash", memo: HASH_B64 }, transfer({ memo: HASH_HEX, memoType: "hash" })),
    ).toBe(true);
  });

  it("rejects a wrong memo, memo type, amount, destination or asset", () => {
    const t = transfer();
    expect(paymentMatchesTransfer(payment, { memo_type: "text", memo: "other" }, t)).toBe(false);
    expect(paymentMatchesTransfer(payment, { memo_type: "id", memo: "abc123" }, t)).toBe(false);
    expect(paymentMatchesTransfer(payment, { memo_type: "none" }, t)).toBe(false);
    expect(paymentMatchesTransfer({ ...payment, amount: "25.4999999" }, { memo_type: "text", memo: "abc123" }, t)).toBe(false);
    expect(paymentMatchesTransfer({ ...payment, to: ISSUER }, { memo_type: "text", memo: "abc123" }, t)).toBe(false);
    expect(paymentMatchesTransfer({ ...payment, asset_issuer: DEST }, { memo_type: "text", memo: "abc123" }, t)).toBe(false);
  });

  it("matches native payments only for native transfers", () => {
    const native = { type: "payment", to: DEST, amount: "25.5", asset_type: "native" };
    const t = transfer({ asset: { code: "XLM", issuer: null }, memo: null, memoType: null });
    expect(paymentMatchesTransfer(native, {}, t)).toBe(true);
    expect(paymentMatchesTransfer(payment, {}, t)).toBe(false);
  });
});
