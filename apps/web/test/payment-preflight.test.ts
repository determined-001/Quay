import { describe, expect, it } from "vitest";
import {
  checkPaymentPreflight,
  horizonPaymentReason,
  type MinimalStellarAccount,
} from "../lib/payment-preflight";

describe("checkPaymentPreflight", () => {
  const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const SELLER_WALLET = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
  const OTHER_WALLET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  const fundedAccountWithUsdc: MinimalStellarAccount = {
    balances: [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: USDC_ISSUER,
        balance: "100.0000000",
      },
      {
        asset_type: "native",
        balance: "10.0000000",
      },
    ],
    subentry_count: 1,
  };

  it("fails when account is not funded / missing", () => {
    const res = checkPaymentPreflight(null, { code: "USDC", issuer: USDC_ISSUER }, "10");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("account_not_funded");
    }
  });

  it("fails when connected address does not match expected seller wallet", () => {
    const res = checkPaymentPreflight(
      fundedAccountWithUsdc,
      { code: "USDC", issuer: USDC_ISSUER },
      "10",
      {
        connectedAddress: OTHER_WALLET,
        expectedAddress: SELLER_WALLET,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("wrong_wallet");
    }
  });

  it("passes when connected address matches expected seller wallet", () => {
    const res = checkPaymentPreflight(
      fundedAccountWithUsdc,
      { code: "USDC", issuer: USDC_ISSUER },
      "10",
      {
        connectedAddress: SELLER_WALLET,
        expectedAddress: SELLER_WALLET,
      },
    );
    expect(res.ok).toBe(true);
  });

  it("fails when trustline is missing for non-native asset", () => {
    const xlmOnlyAccount: MinimalStellarAccount = {
      balances: [
        {
          asset_type: "native",
          balance: "50.0000000",
        },
      ],
      subentry_count: 0,
    };
    const res = checkPaymentPreflight(xlmOnlyAccount, { code: "USDC", issuer: USDC_ISSUER }, "10");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing_trustline");
      expect(res.assetCode).toBe("USDC");
    }
  });

  it("fails when asset balance is insufficient for non-native asset", () => {
    const lowUsdcAccount: MinimalStellarAccount = {
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: USDC_ISSUER,
          balance: "5.0000000",
        },
        {
          asset_type: "native",
          balance: "10.0000000",
        },
      ],
      subentry_count: 1,
    };
    const res = checkPaymentPreflight(lowUsdcAccount, { code: "USDC", issuer: USDC_ISSUER }, "50");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("insufficient_balance");
      expect(res.requiredAmount).toBe("50");
      expect(res.availableBalance).toBe("5");
      expect(res.message).toContain("You need 50 USDC, this wallet has 5.");
    }
  });

  it("fails when native XLM is insufficient for fee on non-native payment", () => {
    const noFeeAccount: MinimalStellarAccount = {
      balances: [
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: USDC_ISSUER,
          balance: "100.0000000",
        },
        {
          asset_type: "native",
          balance: "0.0000010", // 10 stroops < 100 base fee
        },
      ],
      subentry_count: 1,
    };
    const res = checkPaymentPreflight(noFeeAccount, { code: "USDC", issuer: USDC_ISSUER }, "10");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("insufficient_fee");
    }
  });

  it("succeeds for valid non-native asset payment", () => {
    const res = checkPaymentPreflight(
      fundedAccountWithUsdc,
      { code: "USDC", issuer: USDC_ISSUER },
      "50",
    );
    expect(res.ok).toBe(true);
  });

  it("accounts for base reserve on native XLM payments", () => {
    // subentry_count = 0 -> minimum reserve is (2 + 0) * 0.5 = 1.0 XLM (10_000_000 stroops)
    // balance = 5.0 XLM. Available for send = 5.0 - 1.0 - 0.00001 = ~3.99999 XLM
    const nativeAccount: MinimalStellarAccount = {
      balances: [
        {
          asset_type: "native",
          balance: "5.0000000",
        },
      ],
      subentry_count: 0,
    };

    // Asking for 4.5 XLM should fail because reserve locks 1.0 XLM
    const resFail = checkPaymentPreflight(
      nativeAccount,
      { code: "XLM", issuer: null },
      "4.5",
    );
    expect(resFail.ok).toBe(false);
    if (!resFail.ok) {
      expect(resFail.reason).toBe("insufficient_balance");
      expect(resFail.message).toContain("You need 4.5 XLM");
    }

    // Asking for 3.5 XLM should succeed
    const resOk = checkPaymentPreflight(
      nativeAccount,
      { code: "XLM", issuer: null },
      "3.5",
    );
    expect(resOk.ok).toBe(true);
  });

  it("fails when native balance cannot cover minimum reserve and fee", () => {
    const bareAccount: MinimalStellarAccount = {
      balances: [
        {
          asset_type: "native",
          balance: "0.5000000", // below 1.0 XLM reserve
        },
      ],
      subentry_count: 0,
    };
    const res = checkPaymentPreflight(bareAccount, { code: "XLM", issuer: null }, "0.1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("insufficient_fee");
    }
  });
});

describe("horizonPaymentReason", () => {
  it("detects insufficient balance result codes", () => {
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

  it("detects missing trustline result codes", () => {
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

  it("returns payment_rejected for other errors", () => {
    const err = new Error("Network timeout");
    expect(horizonPaymentReason(err)).toBe("payment_rejected");
  });
});
