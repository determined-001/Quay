import { describe, expect, it, vi } from "vitest";
import { Horizon, StrKey } from "@stellar/stellar-sdk";
import { CannotReceiveError } from "@checkout/core";
import { muxedFor, StellarRail } from "../src/stellar-rail";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CFG = { network: "testnet" as const, horizonUrl: "https://horizon-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015", usdcIssuer: ISSUER };

describe("muxedFor", () => {
  it("encodes a valid M-address from a G-address and an id", () => {
    const m = muxedFor(DEST, "123456789");
    expect(m.startsWith("M")).toBe(true);
    expect(StrKey.isValidMed25519PublicKey(m)).toBe(true);
  });

  it("rejects a non-G-address account", () => {
    expect(() => muxedFor("not-an-address", "1")).toThrow();
  });
});

describe("StellarRail.buildRequest — memo mode (default, unchanged)", () => {
  const rail = new StellarRail(CFG);

  it("builds a memo-carrying request against the plain G-address", () => {
    const req = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123",
      message: "Order",
    });
    expect(req.destination).toBe(DEST);
    expect(req.memo).toBe("pl_abc123");
    expect(req.uri).toContain(`destination=${DEST}`);
    expect(req.uri).toContain("memo=pl_abc123");
    expect(req.uri).toContain("memo_type=MEMO_TEXT");
  });

  it("is unaffected by an absent muxedId (explicit null behaves like undefined)", () => {
    const withUndefined = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123",
    });
    const withNull = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123",
      muxedId: null,
    });
    expect(withNull).toEqual(withUndefined);
  });
});

describe("StellarRail.buildRequest — muxed mode", () => {
  const rail = new StellarRail(CFG);

  it("builds against an M-address with no memo", () => {
    const req = rail.buildRequest({
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      reference: "pl_abc123", // ignored for correlation purposes in muxed mode
      muxedId: "123456789",
    });
    expect(req.destination.startsWith("M")).toBe(true);
    expect(req.memo).toBeNull();
    expect(req.uri).not.toContain("memo=");
    expect(req.uri).not.toContain("memo_type=");
    expect(req.uri).toContain(`destination=${req.destination}`);
  });
});

describe("StellarRail.isValidDestination", () => {
  const rail = new StellarRail(CFG);

  it("returns true for a valid Ed25519 public key (G-address)", () => {
    expect(rail.isValidDestination(DEST)).toBe(true);
  });

  it("returns false for invalid addresses", () => {
    expect(rail.isValidDestination("not-an-address")).toBe(false);
    expect(rail.isValidDestination("")).toBe(false);
  });
});

describe("StellarRail.assertCanReceive & checkCanReceive (preflight)", () => {
  const rail = new StellarRail(CFG);
  const USDC = { code: "USDC", issuer: ISSUER };
  const XLM = { code: "XLM", issuer: null };

  function mockAccount(opts: {
    sequence?: string;
    balances?: Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
      limit?: string;
      is_authorized?: boolean;
    }>;
  }) {
    let seq = BigInt(opts.sequence ?? "100");
    return {
      accountId: () => DEST,
      sequenceNumber: () => seq.toString(),
      incrementSequenceNumber: () => {
        seq += 1n;
      },
      balances: opts.balances ?? [],
    };
  }

  it("passes for native XLM when account exists", async () => {
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
      mockAccount({ balances: [{ asset_type: "native", balance: "100" }] }) as any,
    );
    await expect(rail.assertCanReceive(DEST, XLM)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(DEST);
    spy.mockRestore();
  });

  it("throws CannotReceiveError account_not_found on 404 response", async () => {
    const freshRail = new StellarRail(CFG);
    const notFoundErr = Object.assign(new Error("Not Found"), { response: { status: 404 } });
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(notFoundErr);

    const err = await freshRail.assertCanReceive(DEST, USDC).catch((e) => e);
    expect(err).toBeInstanceOf(CannotReceiveError);
    expect(err.reason).toBe("account_not_found");
    expect(err.message).toContain("does not exist on-chain");

    spy.mockRestore();
  });

  it("throws CannotReceiveError account_not_found on NotFoundError name", async () => {
    const freshRail = new StellarRail(CFG);
    const notFoundErr = Object.assign(new Error("Account not found"), { name: "NotFoundError" });
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(notFoundErr);

    const err = await freshRail.assertCanReceive(DEST, USDC).catch((e) => e);
    expect(err).toBeInstanceOf(CannotReceiveError);
    expect(err.reason).toBe("account_not_found");

    spy.mockRestore();
  });

  it("throws CannotReceiveError no_trustline with a valid trustlineUri deep link", async () => {
    const freshRail = new StellarRail(CFG);
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
      mockAccount({
        balances: [{ asset_type: "native", balance: "100" }],
      }) as any,
    );

    const err = await freshRail.assertCanReceive(DEST, USDC).catch((e) => e);
    expect(err).toBeInstanceOf(CannotReceiveError);
    expect(err.reason).toBe("no_trustline");
    expect(err.trustlineUri).toBeDefined();
    expect(err.trustlineUri).toContain("web+stellar:tx?xdr=");
    expect(err.trustlineUri).toContain("network_passphrase=");

    spy.mockRestore();
  });

  it("throws CannotReceiveError trustline_not_authorized when is_authorized is false", async () => {
    const freshRail = new StellarRail(CFG);
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
      mockAccount({
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "10",
            limit: "1000",
            is_authorized: false,
          },
        ],
      }) as any,
    );

    const err = await freshRail.assertCanReceive(DEST, USDC).catch((e) => e);
    expect(err).toBeInstanceOf(CannotReceiveError);
    expect(err.reason).toBe("trustline_not_authorized");
    expect(err.trustlineUri).toBeUndefined();

    spy.mockRestore();
  });

  it("throws CannotReceiveError trustline_limit_exceeded when balance is at or above limit", async () => {
    const freshRail = new StellarRail(CFG);
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
      mockAccount({
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "1000",
            limit: "1000",
            is_authorized: true,
          },
        ],
      }) as any,
    );

    const err = await freshRail.assertCanReceive(DEST, USDC).catch((e) => e);
    expect(err).toBeInstanceOf(CannotReceiveError);
    expect(err.reason).toBe("trustline_limit_exceeded");
    expect(err.trustlineUri).toBeUndefined();

    spy.mockRestore();
  });

  it("passes when trustline exists, is authorized, and has headroom", async () => {
    const freshRail = new StellarRail(CFG);
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
      mockAccount({
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "10",
            limit: "1000",
            is_authorized: true,
          },
        ],
      }) as any,
    );

    await expect(freshRail.assertCanReceive(DEST, USDC)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("throws unexpected non-404 network errors without caching them", async () => {
    const freshRail = new StellarRail(CFG);
    const netErr = new Error("Network ECONNREFUSED");
    const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(netErr);

    await expect(freshRail.assertCanReceive(DEST, USDC)).rejects.toThrow("Network ECONNREFUSED");
    expect(spy).toHaveBeenCalledTimes(1);

    // Should not be cached as a pass or CannotReceiveError; next call still invokes server
    await expect(freshRail.assertCanReceive(DEST, USDC)).rejects.toThrow("Network ECONNREFUSED");
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("caches successful preflight checks and expires after TTL", async () => {
    vi.useFakeTimers();
    try {
      const freshRail = new StellarRail(CFG);
      const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockResolvedValue(
        mockAccount({
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: ISSUER,
              balance: "0",
              limit: "1000",
            },
          ],
        }) as any,
      );

      // First call: cache miss
      await freshRail.assertCanReceive(DEST, USDC);
      expect(spy).toHaveBeenCalledTimes(1);

      // Second call within TTL: cache hit
      await freshRail.assertCanReceive(DEST, USDC);
      expect(spy).toHaveBeenCalledTimes(1);

      // Advance time past TTL (60s)
      vi.advanceTimersByTime(65_000);

      // Third call after TTL: cache miss, re-fetches
      await freshRail.assertCanReceive(DEST, USDC);
      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches CannotReceiveError and rethrows from cache until TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const freshRail = new StellarRail(CFG);
      const notFoundErr = Object.assign(new Error("Not Found"), { response: { status: 404 } });
      const spy = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(notFoundErr);

      // First call: calls server and throws CannotReceiveError
      await expect(freshRail.assertCanReceive(DEST, USDC)).rejects.toBeInstanceOf(CannotReceiveError);
      expect(spy).toHaveBeenCalledTimes(1);

      // Second call: serves cached error without calling server
      await expect(freshRail.assertCanReceive(DEST, USDC)).rejects.toBeInstanceOf(CannotReceiveError);
      expect(spy).toHaveBeenCalledTimes(1);

      // Advance time past TTL
      vi.advanceTimersByTime(65_000);

      // Third call: re-calls server
      await expect(freshRail.assertCanReceive(DEST, USDC)).rejects.toBeInstanceOf(CannotReceiveError);
      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

