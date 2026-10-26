import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Horizon } from "@stellar/stellar-sdk";
import { CannotReceiveError } from "@checkout/core";
import { StellarRail } from "../src/stellar-rail";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CFG = {
  network: "testnet" as const,
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: ISSUER,
};
const USDC = { code: "USDC", issuer: ISSUER };
const XLM = { code: "XLM", issuer: null };

type LoadedAccount = Awaited<ReturnType<Horizon.Server["loadAccount"]>>;

// A real Account: the no_trustline path builds a SEP-7 changeTrust URI from it,
// which needs sequenceNumber() and friends, not only the balances.
const accountWith = (balances: unknown[]): LoadedAccount =>
  Object.assign(new Account(DEST, "100"), { balances }) as unknown as LoadedAccount;

const native = { asset_type: "native", balance: "5.0000000" };
const usdc = (over: Record<string, unknown> = {}) => ({
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: ISSUER,
  balance: "0.0000000",
  limit: "1000.0000000",
  is_authorized: true,
  ...over,
});

function stubLoadAccount() {
  return vi.spyOn(Horizon.Server.prototype, "loadAccount");
}

async function reasonOf(promise: Promise<void>): Promise<CannotReceiveError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CannotReceiveError);
  return err as CannotReceiveError;
}

describe("StellarRail.assertCanReceive — preflight decisions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("account_not_found when Horizon answers 404", async () => {
    stubLoadAccount().mockRejectedValue({ response: { status: 404 } });
    const err = await reasonOf(new StellarRail(CFG).assertCanReceive(DEST, USDC));
    expect(err.reason).toBe("account_not_found");
    expect(err.message).toContain(DEST);
  });

  it("account_not_found when the SDK throws a NotFoundError", async () => {
    stubLoadAccount().mockRejectedValue(Object.assign(new Error("Not Found"), { name: "NotFoundError" }));
    const err = await reasonOf(new StellarRail(CFG).assertCanReceive(DEST, USDC));
    expect(err.reason).toBe("account_not_found");
  });

  it("native XLM passes with no trustline once the account exists", async () => {
    stubLoadAccount().mockResolvedValue(accountWith([native]) as never);
    await expect(new StellarRail(CFG).assertCanReceive(DEST, XLM)).resolves.toBeUndefined();
  });

  it("no_trustline carries a SEP-7 changeTrust URI for the asset", async () => {
    stubLoadAccount().mockResolvedValue(accountWith([native]) as never);
    const err = await reasonOf(new StellarRail(CFG).assertCanReceive(DEST, USDC));
    expect(err.reason).toBe("no_trustline");
    expect(err.trustlineUri).toMatch(/^web\+stellar:tx\?xdr=/);
    expect(err.message).toContain("USDC");
  });

  it("trustline_not_authorized when the issuer has frozen the line", async () => {
    stubLoadAccount().mockResolvedValue(accountWith([native, usdc({ is_authorized: false })]) as never);
    const err = await reasonOf(new StellarRail(CFG).assertCanReceive(DEST, USDC));
    expect(err.reason).toBe("trustline_not_authorized");
    expect(err.trustlineUri).toBeUndefined();
  });

  it("trustline_limit_exceeded when the balance is already at the limit", async () => {
    stubLoadAccount().mockResolvedValue(
      accountWith([native, usdc({ balance: "1000.0000000", limit: "1000.0000000" })]) as never,
    );
    const err = await reasonOf(new StellarRail(CFG).assertCanReceive(DEST, USDC));
    expect(err.reason).toBe("trustline_limit_exceeded");
  });

  it("passes for an authorized trustline with headroom", async () => {
    stubLoadAccount().mockResolvedValue(accountWith([native, usdc()]) as never);
    await expect(new StellarRail(CFG).assertCanReceive(DEST, USDC)).resolves.toBeUndefined();
  });

  it("rethrows an error that is not a CannotReceiveError, and does not cache it", async () => {
    const boom = new Error("horizon exploded");
    const loadAccount = stubLoadAccount()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(accountWith([native, usdc()]) as never);
    const rail = new StellarRail(CFG);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toBe(boom);
    await expect(rail.assertCanReceive(DEST, USDC)).resolves.toBeUndefined();
    expect(loadAccount).toHaveBeenCalledTimes(2);
  });
});

describe("StellarRail.assertCanReceive — cache lifetime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("serves a pass from cache inside the 60 s window and re-checks after it", async () => {
    const loadAccount = stubLoadAccount().mockResolvedValue(accountWith([native, usdc()]) as never);
    const rail = new StellarRail(CFG);

    await rail.assertCanReceive(DEST, USDC);
    vi.advanceTimersByTime(59_000);
    await rail.assertCanReceive(DEST, USDC);
    expect(loadAccount).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await rail.assertCanReceive(DEST, USDC);
    expect(loadAccount).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by account, asset and amount", async () => {
    const loadAccount = stubLoadAccount().mockResolvedValue(accountWith([native, usdc()]) as never);
    const rail = new StellarRail(CFG);

    await rail.assertCanReceive(DEST, USDC, "5");
    await rail.assertCanReceive(DEST, USDC, "6");
    await rail.assertCanReceive(DEST, USDC);
    expect(loadAccount).toHaveBeenCalledTimes(3);
  });
});
