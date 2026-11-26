import { describe, expect, it } from "vitest";
import { normalizePayment } from "../src/normalize";
import {
  asHorizonRecord,
  strictReceiveFixture,
  strictSendFixture,
} from "./path-payment-fixtures";
import fromMuxedFixture from "./fixtures/payment-from-muxed.json";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function record(over: Record<string, unknown> = {}) {
  return {
    type: "payment",
    paging_token: "1",
    transaction_hash: "tx1",
    created_at: "2026-01-01T00:00:00Z",
    to: DEST,
    from: "GBUYER",
    amount: "10",
    asset_type: "native",
    transaction: async () => ({ memo_type: "none", memo: undefined }),
    ...over,
  };
}

describe("normalizePayment", () => {
  it("sets toMuxedId to null for an ordinary G-address payment", async () => {
    const payment = await normalizePayment(record() as any);
    expect(payment?.toMuxedId).toBeNull();
  });

  it("decodes to_muxed_id when the payer sent to an M-address", async () => {
    const payment = await normalizePayment(record({ to_muxed_id: "123456789" }) as any);
    expect(payment?.toMuxedId).toBe("123456789");
    // `to` still resolves to the underlying G-address regardless of muxing.
    expect(payment?.to).toBe(DEST);
  });

  it("sets fromMuxed to null for a payment from a G-address", async () => {
    const payment = await normalizePayment(record() as any);
    expect(payment?.fromMuxed).toBeNull();
  });

  // A real mainnet operation; see fixtures/README.md.
  it("keeps the M-address of a payment sent from one, and the G-address under it", async () => {
    const fixture = { ...fromMuxedFixture, transaction: async () => fromMuxedFixture.transaction };
    const payment = await normalizePayment(fixture as any);

    expect(payment?.fromMuxed).toBe("MD3ZN2T6QQMKLAGKKMWHHY4FITANVJBTREEJERHTWGWF2GSBPOSHGAAAAAAAAAAGMXH4A");
    expect(payment?.from).toBe("GD3ZN2T6QQMKLAGKKMWHHY4FITANVJBTREEJERHTWGWF2GSBPOSHGCLU");
    // The sender being muxed says nothing about the destination.
    expect(payment?.toMuxedId).toBeNull();
    expect(payment?.amount).toBe("100.0000000");
  });

  it("returns null for non-value operations regardless of muxing", async () => {
    const payment = await normalizePayment(record({ type: "create_account", to_muxed_id: "1" }) as any);
    expect(payment).toBeNull();
  });
});

// Path payments (issue 2.17). Horizon puts the delivered (destination) amount
// and asset in `amount`/`asset_*` and the paid side in `source_amount`/
// `source_asset_*`. The matcher settles on the delivered side, so normalization
// must keep exactly that; the paid side is carried for receipts and CSVs only.
// Fixtures are real testnet operations — see fixtures/README.md.
describe("normalizePayment: path payments settle on the delivered side", () => {
  it("path_payment_strict_receive takes amount/asset from the destination side", async () => {
    const payment = await normalizePayment(asHorizonRecord(strictReceiveFixture) as any);

    // Delivered: 0.0000900 XLM. Paid: 0.0000007 USDC — deliberately different.
    expect(payment?.amount).toBe("0.0000900");
    expect(payment?.asset).toEqual({ code: "XLM", issuer: null });
    expect(payment?.amount).not.toBe(strictReceiveFixture.source_amount);

    expect(payment?.sourceAmount).toBe("0.0000007");
    expect(payment?.sourceAsset).toEqual({
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
  });

  it("path_payment_strict_send takes amount/asset from the destination side", async () => {
    const payment = await normalizePayment(asHorizonRecord(strictSendFixture) as any);

    // Delivered: 40 MOON. Paid: 10 IOM — deliberately different.
    expect(payment?.amount).toBe("40.0000000");
    expect(payment?.asset).toEqual({
      code: "MOON",
      issuer: "GBHQNYHTJGLEJ5JRKGVY3P52FK2MQ4YXAI4CNIMWV5YQTHV6ZDBCWSQ7",
    });
    expect(payment?.amount).not.toBe(strictSendFixture.source_amount);

    expect(payment?.sourceAmount).toBe("10.0000000");
    expect(payment?.sourceAsset).toEqual({
      code: "IOM",
      issuer: "GBHQNYHTJGLEJ5JRKGVY3P52FK2MQ4YXAI4CNIMWV5YQTHV6ZDBCWSQ7",
    });
  });

  it("plain payments have no paid side", async () => {
    const payment = await normalizePayment(record() as any);
    expect(payment?.sourceAsset).toBeNull();
    expect(payment?.sourceAmount).toBeNull();
  });
});
