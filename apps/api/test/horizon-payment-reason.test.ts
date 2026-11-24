import { describe, expect, it } from "vitest";
import { horizonPaymentReason } from "../src/services/link-service";

describe("horizonPaymentReason (API)", () => {
  it("detects price_moved (op_over_source_max)", () => {
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
    expect(horizonPaymentReason(err)).toBe("price_moved");
  });

  it("detects no_path (op_too_few_offers)", () => {
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
    expect(horizonPaymentReason(err)).toBe("no_path");
  });

  it("detects insufficient_balance", () => {
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
    expect(horizonPaymentReason(err)).toBe("insufficient_balance");
  });

  it("detects missing_trustline", () => {
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
    expect(horizonPaymentReason(err)).toBe("missing_trustline");
  });

  it("returns payment_rejected for unknown errors", () => {
    const err = new Error("Network timeout");
    expect(horizonPaymentReason(err)).toBe("payment_rejected");
  });
});
