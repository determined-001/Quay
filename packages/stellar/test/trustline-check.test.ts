import { describe, expect, it } from "vitest";
import { checkBalance, findAssetBalance, messageFor, type BalanceLine } from "../src/trustline-check";

const USDC = { code: "USDC", issuer: "GISSUER" };

describe("findAssetBalance", () => {
  it("finds the matching asset among several balance lines", () => {
    const balances: BalanceLine[] = [
      { asset_type: "native", balance: "50" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER", balance: "10", limit: "1000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GOTHER", balance: "5", limit: "1000" },
    ];
    const found = findAssetBalance(balances, USDC);
    expect(found?.balance).toBe("10");
  });

  it("returns undefined when there's no matching trustline", () => {
    const balances: BalanceLine[] = [{ asset_type: "native", balance: "50" }];
    expect(findAssetBalance(balances, USDC)).toBeUndefined();
  });
});

describe("checkBalance", () => {
  it("returns no_trustline when there's no balance line at all", () => {
    expect(checkBalance(undefined, USDC)).toBe("no_trustline");
  });

  it("returns trustline_not_authorized when the issuer froze it", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "10", limit: "1000", is_authorized: false };
    expect(checkBalance(balance, USDC)).toBe("trustline_not_authorized");
  });

  it("returns trustline_limit_exceeded when balance has reached the limit", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "1000", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC)).toBe("trustline_limit_exceeded");
  });

  it("returns null (can receive) for a normal, under-limit, authorized trustline", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "10", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC)).toBeNull();
  });

  it("treats a missing limit as unbounded, not exceeded", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "999999", is_authorized: true };
    expect(checkBalance(balance, USDC)).toBeNull();
  });

  it("accepts 1 stroop of headroom near max amount (float precision edge case)", () => {
    const balance: BalanceLine = {
      asset_type: "credit_alphanum4",
      balance: "922337203685.4775806",
      limit: "922337203685.4775807",
      is_authorized: true,
    };
    expect(checkBalance(balance, USDC)).toBeNull();
  });

  it("rejects when balance equals limit near max amount", () => {
    const balance: BalanceLine = {
      asset_type: "credit_alphanum4",
      balance: "922337203685.4775807",
      limit: "922337203685.4775807",
      is_authorized: true,
    };
    expect(checkBalance(balance, USDC)).toBe("trustline_limit_exceeded");
  });

  it("accepts an amount equal to headroom", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "995", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC, "5")).toBeNull();
  });

  it("rejects an amount one stroop over headroom", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "995", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC, "5.0000001")).toBe("trustline_limit_exceeded");
  });

  it("rejects when headroom is less than link amount (balance 995, limit 1000, amount 100)", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "995", limit: "1000", is_authorized: true };
    expect(checkBalance(balance, USDC, "100")).toBe("trustline_limit_exceeded");
  });

  it("fails open (returns null) on unparsable values", () => {
    const invalidBal: BalanceLine = { asset_type: "credit_alphanum4", balance: "not-a-number", limit: "1000", is_authorized: true };
    expect(checkBalance(invalidBal, USDC)).toBeNull();

    const invalidLim: BalanceLine = { asset_type: "credit_alphanum4", balance: "995", limit: "invalid-limit", is_authorized: true };
    expect(checkBalance(invalidLim, USDC, "10")).toBeNull();

    const invalidAmt: BalanceLine = { asset_type: "credit_alphanum4", balance: "995", limit: "1000", is_authorized: true };
    expect(checkBalance(invalidAmt, USDC, "invalid-amount")).toBeNull();
  });
});

describe("messageFor", () => {
  it("names the missing trustline's issuer for no_trustline", () => {
    const msg = messageFor("no_trustline", "GACCOUNT", USDC);
    expect(msg).toContain("USDC");
    expect(msg).toContain("GISSUER");
  });

  it("names the account for account_not_found", () => {
    expect(messageFor("account_not_found", "GACCOUNT", USDC)).toContain("GACCOUNT");
  });

  it("mentions remaining headroom and requested amount when headroom is positive but insufficient", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "995", limit: "1000" };
    const msg = messageFor("trustline_limit_exceeded", "GACCOUNT", USDC, balance, "100");
    expect(msg).toBe(
      "The USDC trustline on GACCOUNT has only 5 headroom remaining, which cannot receive 100 — raise the limit to receive more.",
    );
  });

  it("retains 'already at its limit' when headroom is zero", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "1000", limit: "1000" };
    const msg = messageFor("trustline_limit_exceeded", "GACCOUNT", USDC, balance, "100");
    expect(msg).toBe("The USDC trustline on GACCOUNT is already at its limit (1000) — raise it to receive more.");
  });

  it("retains 'already at its limit' when amount is not provided", () => {
    const balance: BalanceLine = { asset_type: "credit_alphanum4", balance: "1000", limit: "1000" };
    const msg = messageFor("trustline_limit_exceeded", "GACCOUNT", USDC, balance);
    expect(msg).toBe("The USDC trustline on GACCOUNT is already at its limit (1000) — raise it to receive more.");
  });
});
