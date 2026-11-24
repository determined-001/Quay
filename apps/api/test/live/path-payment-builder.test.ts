import { describe, expect, it } from "vitest";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import {
  buildPathPayment,
  calculateSendMax,
  extractHorizonPaymentReason,
  toSdkAsset,
} from "./path-payment-builder";

describe("path-payment-builder", () => {
  describe("toSdkAsset", () => {
    it("converts XLM with null issuer to native Asset", () => {
      const asset = toSdkAsset({ code: "XLM", issuer: null });
      expect(asset.isNative()).toBe(true);
    });

    it("converts issued asset to non-native Asset", () => {
      const issuer = Keypair.random().publicKey();
      const asset = toSdkAsset({ code: "USDC", issuer });
      expect(asset.isNative()).toBe(false);
      expect(asset.getCode()).toBe("USDC");
      expect(asset.getIssuer()).toBe(issuer);
    });
  });

  describe("calculateSendMax", () => {
    it("computes 100 bps (1%) slippage ceiling-rounded", () => {
      // 20.0000000 + 1% = 20.2
      expect(calculateSendMax("20.0000000", 100)).toBe("20.2");
    });

    it("never rounds down at stroop boundaries", () => {
      // 0.0000001 (1 stroop) + 100 bps:
      // (1 * 10100 + 9999) / 10000 = 20099 / 10000 = 2 stroops (0.0000002)
      expect(calculateSendMax("0.0000001", 100)).toBe("0.0000002");
    });

    it("handles arbitrary slippage basis points", () => {
      // 10.0000000 with 300 bps (3%) -> 10.3
      expect(calculateSendMax("10.0000000", 300)).toBe("10.3");
    });
  });

  describe("buildPathPayment", () => {
    it("builds a valid path_payment_strict_receive transaction matching 5.48", () => {
      const source = Keypair.random().publicKey();
      const dest = Keypair.random().publicKey();
      const issuer = Keypair.random().publicKey();

      const tx = buildPathPayment({
        sourceAccount: source,
        sequence: "1",
        destination: dest,
        destAsset: { code: "USDC", issuer },
        destAmount: "10.0000000",
        sendAsset: { code: "XLM", issuer: null },
        sendMax: "20.2000000",
        path: [],
        memo: "ref_12345",
        expiresAt: Date.now() + 60_000,
      });

      expect(tx.operations).toHaveLength(1);
      const op = tx.operations[0] as Operation.PathPaymentStrictReceive;
      expect(op.type).toBe("pathPaymentStrictReceive");
      expect(op.destination).toBe(dest);
      expect(op.destAsset.getCode()).toBe("USDC");
      expect(op.destAmount).toBe("10.0000000");
      expect(op.sendAsset.isNative()).toBe(true);
      expect(op.sendMax).toBe("20.2000000");
      expect(op.path).toHaveLength(0);
      expect(tx.memo.value?.toString()).toBe("ref_12345");
    });
  });

  describe("extractHorizonPaymentReason", () => {
    it("detects price_moved for op_over_source_max", () => {
      const err = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_failed",
                operations: ["op_over_source_max"],
              },
            },
          },
        },
      };
      expect(extractHorizonPaymentReason(err)).toBe("price_moved");
    });

    it("detects no_path for op_too_few_offers", () => {
      const err = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_failed",
                operations: ["op_too_few_offers"],
              },
            },
          },
        },
      };
      expect(extractHorizonPaymentReason(err)).toBe("no_path");
    });

    it("detects insufficient_balance for op_underfunded", () => {
      const err = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_failed",
                operations: ["op_underfunded"],
              },
            },
          },
        },
      };
      expect(extractHorizonPaymentReason(err)).toBe("insufficient_balance");
    });

    it("detects missing_trustline for op_no_trust", () => {
      const err = {
        response: {
          data: {
            extras: {
              result_codes: {
                transaction: "tx_failed",
                operations: ["op_no_trust"],
              },
            },
          },
        },
      };
      expect(extractHorizonPaymentReason(err)).toBe("missing_trustline");
    });

    it("returns payment_rejected for generic errors", () => {
      expect(extractHorizonPaymentReason(new Error("Network failure"))).toBe("payment_rejected");
    });
  });
});
