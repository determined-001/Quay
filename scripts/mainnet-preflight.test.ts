import { describe, expect, it } from "vitest";
import {
  CIRCLE_USDC_ISSUER_PUBNET,
  checkDatabase,
  checkOfframp,
  checkSellerWallet,
  checkUsdcIssuer,
  checkWebEnv,
  evaluateAccount,
  evaluateHealth,
  exitCodeFor,
  probeAccount,
  probeDeploy,
  runStaticChecks,
} from "./mainnet-preflight.mjs";

const WALLET = "GBMDH3QWSD74ILWD2ZVFOAOCMVRNPNGAHN557WA4KABLI5IFN2XYLMGY";

/** A configuration that passes every blocking check, to vary one field at a time. */
const GOOD = {
  STELLAR_NETWORK: "public",
  DATABASE_URL: "libsql://quay-prod.turso.io",
  DATABASE_AUTH_TOKEN: "tok",
  USDC_ISSUER_PUBLIC: CIRCLE_USDC_ISSUER_PUBNET,
  OFFRAMP: "none",
  NEXT_PUBLIC_OFFRAMP_MODE: "none",
  NEXT_PUBLIC_STELLAR_NETWORK: "public",
  DEFAULT_SELLER_WALLET: WALLET,
  SERVER_SIGNING_SECRET: "S".repeat(56),
  JWT_SECRET: "a".repeat(64),
  WEBHOOK_SECRET_ENCRYPTION_KEY: "b".repeat(64),
  METRICS_TOKEN: "c".repeat(64),
};

const blocking = (results: { ok: boolean; level: string }[]) =>
  results.filter((r) => !r.ok && r.level === "blocking");

describe("runStaticChecks", () => {
  it("a payments-only pubnet config has nothing blocking", () => {
    expect(blocking(runStaticChecks(GOOD))).toEqual([]);
  });

  it("exits non-zero on a blocking failure and zero on warnings alone", () => {
    expect(exitCodeFor(runStaticChecks(GOOD))).toBe(0);
    expect(exitCodeFor(runStaticChecks({ ...GOOD, DATABASE_URL: "file:./local.db" }))).toBe(1);
  });
});

describe("checkDatabase", () => {
  it("rejects the file: fallback that loses the ledger on redeploy", () => {
    expect(checkDatabase({ DATABASE_URL: "file:./local.db" }).ok).toBe(false);
    expect(checkDatabase({}).ok).toBe(false);
  });

  it("requires an auth token for a remote libsql database", () => {
    expect(checkDatabase({ DATABASE_URL: "libsql://x.turso.io" }).ok).toBe(false);
    expect(checkDatabase({ DATABASE_URL: "libsql://x.turso.io", DATABASE_AUTH_TOKEN: "t" }).ok).toBe(true);
  });
});

describe("checkUsdcIssuer", () => {
  it("accepts only Circle's published pubnet issuer", () => {
    expect(checkUsdcIssuer({ USDC_ISSUER_PUBLIC: CIRCLE_USDC_ISSUER_PUBNET }).ok).toBe(true);
  });

  it("rejects a lookalike issuer — an asset coded USDC from anyone else is worth nothing", () => {
    const res = checkUsdcIssuer({ USDC_ISSUER_PUBLIC: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVX" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("NOT Circle's published pubnet issuer");
  });
});

describe("checkOfframp", () => {
  it("refuses the two sandbox modes on pubnet", () => {
    expect(checkOfframp({ OFFRAMP: "mock" }).ok).toBe(false);
    expect(checkOfframp({ OFFRAMP: "testanchor" }).ok).toBe(false);
    expect(checkOfframp({}).ok).toBe(false); // unset defaults to mock
  });

  it("accepts payments-only", () => {
    expect(checkOfframp({ OFFRAMP: "none" }).ok).toBe(true);
  });

  it("requires an https anchor and a KYC key in anchor mode", () => {
    expect(checkOfframp({ OFFRAMP: "anchor" }).ok).toBe(false);
    expect(checkOfframp({ OFFRAMP: "anchor", ANCHOR_URL: "http://a.example", ANCHOR_HOME_DOMAIN: "a.example", KYC_ENCRYPTION_KEY: "k" }).ok).toBe(false);
    expect(checkOfframp({ OFFRAMP: "anchor", ANCHOR_URL: "https://a.example", ANCHOR_HOME_DOMAIN: "a.example" }).ok).toBe(false);
    expect(checkOfframp({ OFFRAMP: "anchor", ANCHOR_URL: "https://a.example", ANCHOR_HOME_DOMAIN: "a.example", KYC_ENCRYPTION_KEY: "k" }).ok).toBe(true);
  });
});

describe("checkSellerWallet", () => {
  it("rejects a missing or malformed wallet", () => {
    expect(checkSellerWallet({}).ok).toBe(false);
    expect(checkSellerWallet({ DEFAULT_SELLER_WALLET: "not-a-key" }).ok).toBe(false);
  });

  it("warns when a seller secret is held with no anchor to sign for", () => {
    const res = checkSellerWallet({ ...GOOD, DEFAULT_SELLER_SECRET: "S".repeat(56) });
    expect(res.ok).toBe(false);
    expect(res.level).toBe("warning");
  });
});

describe("checkWebEnv", () => {
  it("blocks a web deployment left on testnet — every wallet signature would be rejected with no error naming the cause", () => {
    const [network] = checkWebEnv({ ...GOOD, NEXT_PUBLIC_STELLAR_NETWORK: undefined });
    expect(network.ok).toBe(false);
  });

  it("blocks a dashboard whose off-ramp mode disagrees with the API's", () => {
    const [, offramp] = checkWebEnv({ ...GOOD, OFFRAMP: "none", NEXT_PUBLIC_OFFRAMP_MODE: "anchor" });
    expect(offramp.ok).toBe(false);
  });
});

describe("evaluateAccount", () => {
  const native = (balance: string) => ({ asset_type: "native", balance });
  const usdc = (limit = "10000", balance = "0", issuer = CIRCLE_USDC_ISSUER_PUBNET) => ({
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: issuer,
    balance,
    limit,
  });

  it("passes a funded account with a Circle USDC trustline", () => {
    expect(blocking(evaluateAccount({ balances: [native("10"), usdc()] }))).toEqual([]);
  });

  it("blocks an account with XLM but no trustline — it cannot receive USDC at all", () => {
    const res = evaluateAccount({ balances: [native("10")] });
    expect(blocking(res)).toHaveLength(1);
    expect(res[1].detail).toContain("cannot receive USDC at all");
  });

  it("blocks a trustline to a USDC from the wrong issuer", () => {
    const res = evaluateAccount({ balances: [native("10"), usdc("10000", "0", "G" + "B".repeat(55))] });
    expect(res[1].ok).toBe(false);
    expect(res[1].detail).toContain("NOT Circle's");
  });

  it("blocks an account too thin to cover the reserve of a trustline", () => {
    expect(evaluateAccount({ balances: [native("1"), usdc()] })[0].ok).toBe(false);
  });

  it("blocks a full trustline, which would reject further payments", () => {
    expect(evaluateAccount({ balances: [native("10"), usdc("100", "100")] })[1].ok).toBe(false);
  });
});

describe("evaluateHealth", () => {
  it("blocks when the deployed API is not the mainnet service", () => {
    const res = evaluateHealth({ ok: true, network: "testnet" });
    expect(res[0].ok).toBe(false);
    expect(res[0].detail).toContain("not the mainnet service");
  });

  it("passes a green pubnet deploy", () => {
    expect(blocking(evaluateHealth({ ok: true, network: "public" }))).toEqual([]);
  });
});

describe("probes", () => {
  it("reports a nonexistent pubnet account as blocking", async () => {
    const res = await probeAccount(WALLET, { fetchJson: async () => ({ status: 404, body: null }) });
    expect(res[0].ok).toBe(false);
    expect(res[0].detail).toContain("does not exist on pubnet");
  });

  it("degrades to a warning when Horizon is unreachable rather than claiming a failure it did not observe", async () => {
    const res = await probeAccount(WALLET, {
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(res[0].level).toBe("warning");
  });

  it("blocks when /ready is not green — payments would settle on the ledger and never be marked paid", async () => {
    const res = await probeDeploy("https://api.example", {
      fetchJson: async (url: string) =>
        url.endsWith("/health")
          ? { status: 200, body: { ok: true, network: "public" } }
          : { status: 503, body: null },
    });
    expect(res.find((r) => r.id === "live:ready")?.ok).toBe(false);
  });
});
