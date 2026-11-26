import { describe, expect, it } from "vitest";
import {
  MEMO_REQUIRED_DATA_KEY,
  accountRequiresMemo,
  resolveRefundDestination,
} from "../src/refund-destination";
import { normalizePayment } from "../src/normalize";
import memoRequiredAccount from "./fixtures/account-memo-required.json";
import fromMuxed from "./fixtures/payment-from-muxed.json";

const PAYER = "GD3ZN2T6QQMKLAGKKMWHHY4FITANVJBTREEJERHTWGWF2GSBPOSHGCLU";
const PAYER_MUXED = "MD3ZN2T6QQMKLAGKKMWHHY4FITANVJBTREEJERHTWGWF2GSBPOSHGAAAAAAAAAAGMXH4A";

// The SDK's AccountResponse exposes Horizon's `data` object as `data_attr`.
const ordinary = { data_attr: {} };
const memoRequired = { data_attr: memoRequiredAccount.data };

describe("resolveRefundDestination (issue 2.14)", () => {
  it("is ready, to the G-address, for an ordinary payer", () => {
    expect(resolveRefundDestination({ payer: PAYER, payerMuxed: null }, ordinary)).toEqual({
      kind: "ready",
      destination: PAYER,
    });
    expect(resolveRefundDestination({ payer: PAYER }, {})).toEqual({ kind: "ready", destination: PAYER });
  });

  it("is ready, to the M-address, when the payer sent from one", () => {
    expect(resolveRefundDestination({ payer: PAYER, payerMuxed: PAYER_MUXED }, ordinary)).toEqual({
      kind: "ready",
      destination: PAYER_MUXED,
    });
  });

  it("needs a memo when the account sets config.memo_required", () => {
    expect(resolveRefundDestination({ payer: PAYER, payerMuxed: null }, memoRequired)).toEqual({
      kind: "needs_memo",
      destination: PAYER,
    });
  });

  it("does not ask for a memo when the M-address already names the customer", () => {
    expect(resolveRefundDestination({ payer: PAYER, payerMuxed: PAYER_MUXED }, memoRequired)).toEqual({
      kind: "ready",
      destination: PAYER_MUXED,
    });
  });

  it("reports an account that no longer exists, whatever the payer looked like", () => {
    expect(resolveRefundDestination({ payer: PAYER, payerMuxed: null }, null)).toEqual({ kind: "account_gone" });
    expect(resolveRefundDestination({ payer: PAYER, payerMuxed: PAYER_MUXED }, null)).toEqual({
      kind: "account_gone",
    });
  });

  it("resolves a real payment sent from an M-address to that M-address", async () => {
    const record = { ...fromMuxed, transaction: async () => fromMuxed.transaction };
    const payment = await normalizePayment(record as any);

    expect(
      resolveRefundDestination({ payer: payment!.from, payerMuxed: payment!.fromMuxed }, ordinary),
    ).toEqual({ kind: "ready", destination: fromMuxed.from_muxed });
  });
});

describe("accountRequiresMemo: SEP-29's data entry, base64 as Horizon returns it", () => {
  it("reads the real account fixture, whose value is base64 for 1", () => {
    expect(memoRequiredAccount.data[MEMO_REQUIRED_DATA_KEY]).toBe("MQ==");
    expect(accountRequiresMemo(memoRequired)).toBe(true);
  });

  it("is false for any other value, decoded and not compared as base64 text", () => {
    const withValue = (plain: string) => ({
      data_attr: { [MEMO_REQUIRED_DATA_KEY]: Buffer.from(plain, "utf8").toString("base64") },
    });
    expect(accountRequiresMemo(withValue("1"))).toBe(true);
    expect(accountRequiresMemo(withValue("0"))).toBe(false);
    expect(accountRequiresMemo(withValue(""))).toBe(false);
    expect(accountRequiresMemo(withValue("true"))).toBe(false);
    expect(accountRequiresMemo(withValue("11"))).toBe(false);
    // The undecoded text "1" is not the entry being on.
    expect(accountRequiresMemo({ data_attr: { [MEMO_REQUIRED_DATA_KEY]: "1" } })).toBe(false);
  });

  it("is false without the entry, with other entries, and without data at all", () => {
    expect(accountRequiresMemo({ data_attr: {} })).toBe(false);
    expect(accountRequiresMemo({ data_attr: { "config.other": "MQ==" } })).toBe(false);
    expect(accountRequiresMemo({})).toBe(false);
  });
});
