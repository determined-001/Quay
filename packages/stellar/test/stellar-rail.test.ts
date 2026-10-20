import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
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

  it("validates valid and invalid Stellar public keys", () => {
    expect(rail.isValidDestination(DEST)).toBe(true);
    expect(rail.isValidDestination(ISSUER)).toBe(true);
    expect(rail.isValidDestination("not-a-valid-address")).toBe(false);
    expect(rail.isValidDestination("")).toBe(false);
    expect(rail.isValidDestination("SA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(false);
  });
});

describe("StellarRail.assertCanReceive & checkCanReceive", () => {
  const USDC = { code: "USDC", issuer: ISSUER };
  const XLM = { code: "XLM", issuer: null };

  function mockHorizonAccount(balances: unknown[] = [], seq = "100") {
    return {
      accountId: () => DEST,
      sequenceNumber: () => seq,
      incrementSequenceNumber: () => (Number(seq) + 1).toString(),
      balances,
    };
  }

  it("passes for native XLM when account exists", async () => {
    const fakeServer = {
      loadAccount: async () => mockHorizonAccount([]),
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, XLM)).resolves.toBeUndefined();
  });

  it("throws CannotReceiveError with account_not_found on 404 response", async () => {
    const fakeServer = {
      loadAccount: async () => {
        const err: any = new Error("Not Found");
        err.response = { status: 404 };
        throw err;
      },
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toThrow(CannotReceiveError);
    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toMatchObject({
      reason: "account_not_found",
    });
  });

  it("throws CannotReceiveError with account_not_found on NotFoundError name", async () => {
    const fakeServer = {
      loadAccount: async () => {
        const err: any = new Error("Account not found");
        err.name = "NotFoundError";
        throw err;
      },
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toThrow(CannotReceiveError);
    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toMatchObject({
      reason: "account_not_found",
    });
  });

  it("re-throws unexpected server errors and does not cache them", async () => {
    let callCount = 0;
    const fakeServer = {
      loadAccount: async () => {
        callCount++;
        throw new Error("500 Internal Server Error");
      },
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toThrow("500 Internal Server Error");
    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toThrow("500 Internal Server Error");
    expect(callCount).toBe(2); // Not cached
  });

  it("throws no_trustline with trustlineUri when asset trustline is missing", async () => {
    const fakeServer = {
      loadAccount: async () => mockHorizonAccount([]),
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    try {
      await rail.assertCanReceive(DEST, USDC);
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(CannotReceiveError);
      expect(err.reason).toBe("no_trustline");
      expect(err.trustlineUri).toBeDefined();
      expect(err.trustlineUri).toContain("web+stellar:tx?xdr=");
      expect(err.message).toContain("no trustline");
    }
  });

  it("throws trustline_not_authorized when trustline is deauthorized", async () => {
    const fakeServer = {
      loadAccount: async () =>
        mockHorizonAccount([
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            limit: "10000.0000000",
            is_authorized: false,
          },
        ]),
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toThrow(CannotReceiveError);
    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toMatchObject({
      reason: "trustline_not_authorized",
    });
  });

  it("throws trustline_limit_exceeded when balance is at or over limit", async () => {
    const fakeServer = {
      loadAccount: async () =>
        mockHorizonAccount([
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "1000.0000000",
            limit: "10000.0000000", // limit 1000, wait, balance 1000 limit 1000
            is_authorized: true,
          },
        ]),
    };
    (fakeServer as any).loadAccount = async () =>
      mockHorizonAccount([
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: ISSUER,
          balance: "1000.0000000",
          limit: "1000.0000000",
          is_authorized: true,
        },
      ]);
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toThrow(CannotReceiveError);
    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toMatchObject({
      reason: "trustline_limit_exceeded",
    });
  });

  it("passes when trustline is valid, authorized, and has headroom", async () => {
    const fakeServer = {
      loadAccount: async () =>
        mockHorizonAccount([
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            limit: "1000.0000000",
            is_authorized: true,
          },
        ]),
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).resolves.toBeUndefined();
  });

  it("caches successful preflight checks until expiry", async () => {
    let callCount = 0;
    const fakeServer = {
      loadAccount: async () => {
        callCount++;
        return mockHorizonAccount([
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            limit: "1000.0000000",
            is_authorized: true,
          },
        ]);
      },
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await rail.assertCanReceive(DEST, USDC);
    expect(callCount).toBe(1);

    // Immediate second call uses cache
    await rail.assertCanReceive(DEST, USDC);
    expect(callCount).toBe(1);
  });

  it("caches CannotReceiveError checks until expiry and re-throws cached error", async () => {
    let callCount = 0;
    const fakeServer = {
      loadAccount: async () => {
        callCount++;
        return mockHorizonAccount([]);
      },
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toMatchObject({
      reason: "no_trustline",
    });
    expect(callCount).toBe(1);

    // Immediate second call uses cached error
    await expect(rail.assertCanReceive(DEST, USDC)).rejects.toMatchObject({
      reason: "no_trustline",
    });
    expect(callCount).toBe(1);
  });

  it("invalidates cache when TTL expires", async () => {
    let now = 1000000;
    const realNow = Date.now;
    Date.now = () => now;

    try {
      let callCount = 0;
      const fakeServer = {
        loadAccount: async () => {
          callCount++;
          return mockHorizonAccount([
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: ISSUER,
              balance: "0.0000000",
              limit: "1000.0000000",
            },
          ]);
        },
      };
      const rail = new StellarRail(CFG, fakeServer as any);

      await rail.assertCanReceive(DEST, USDC);
      expect(callCount).toBe(1);

      // Advance past 60s cache TTL
      now += 61_000;

      await rail.assertCanReceive(DEST, USDC);
      expect(callCount).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("separates cache entries per account, asset code, and issuer", async () => {
    let callCount = 0;
    const fakeServer = {
      loadAccount: async () => {
        callCount++;
        return mockHorizonAccount([
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "0.0000000",
            limit: "1000.0000000",
          },
        ]);
      },
    };
    const rail = new StellarRail(CFG, fakeServer as any);

    await rail.assertCanReceive(DEST, USDC);
    expect(callCount).toBe(1);

    // Native XLM has different cache key
    await rail.assertCanReceive(DEST, XLM);
    expect(callCount).toBe(2);

    // Another account has different cache key
    await rail.assertCanReceive("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", XLM);
    expect(callCount).toBe(3);
  });
});
