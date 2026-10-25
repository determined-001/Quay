import { describe, expect, it } from "vitest";
import {
  CIRCLE_USDC_ISSUER_PUBNET,
  PUBNET_PASSPHRASE,
  checkAnchorToml,
  parseTomlForPreflight,
  checkDatabase,
  checkScaling,
  checkSecrets,
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
  SINGLE_INSTANCE: "true",
  DATABASE_URL: "libsql://quay-prod.turso.io",
  DATABASE_AUTH_TOKEN: "tok",
  USDC_ISSUER_PUBLIC: CIRCLE_USDC_ISSUER_PUBNET,
  OFFRAMP: "none",
  NEXT_PUBLIC_OFFRAMP_MODE: "none",
  NEXT_PUBLIC_STELLAR_NETWORK: "public",
  DEFAULT_SELLER_WALLET: WALLET,
  SERVER_SIGNING_SECRET: "S" + "A".repeat(55),
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
  it("does not block when there is no wallet — multi-tenant is the normal path", () => {
    const res = checkSellerWallet({ OFFRAMP: "none" });
    expect(res.level).toBe("warning");
    expect(res.detail).toMatch(/sellers supply their own wallet/);
  });

  it("still rejects a malformed wallet when one is given", () => {
    expect(checkSellerWallet({ DEFAULT_SELLER_WALLET: "not-a-key" }).ok).toBe(false);
  });

  it("blocks when a seller secret is held on public network", () => {
    const res = checkSellerWallet({ ...GOOD, DEFAULT_SELLER_SECRET: "S".repeat(56) });
    expect(res.ok).toBe(false);
    expect(res.level).toBe("blocking");
    expect(res.detail).toMatch(/DEFAULT_SELLER_SECRET is set on the public network/);
  });

  it("does not require a seller secret for OFFRAMP=anchor", () => {
    expect(checkSellerWallet({ ...GOOD, OFFRAMP: "anchor" }).ok).toBe(true);
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

describe("checkScaling", () => {
  it("blocks the config the API itself refuses to boot on", () => {
    const res = checkScaling({});
    expect(res.ok).toBe(false);
    expect(res.level).toBe("blocking");
    expect(res.detail).toMatch(/refuse to boot/);
  });

  it("passes outright when Redis is configured", () => {
    expect(checkScaling({ REDIS_URL: "redis://x" }).ok).toBe(true);
  });

  it("warns, but does not block, on an explicit single-instance deploy", () => {
    const res = checkScaling({ SINGLE_INSTANCE: "true" });
    expect(res.level).toBe("warning");
  });
});

describe("checkSecrets — SERVER_SIGNING_SECRET shape", () => {
  const find = (env: Record<string, string>) =>
    checkSecrets(env).find((r) => r.id === "secret:SERVER_SIGNING_SECRET")!;

  it("blocks a 64-hex value and says which variables that shape belongs to", () => {
    const res = find({ ...GOOD, SERVER_SIGNING_SECRET: "a".repeat(64) });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/JWT_SECRET \/ METRICS_TOKEN \/ WEBHOOK_SECRET_ENCRYPTION_KEY/);
  });

  it("accepts a well-formed seed", () => {
    expect(find({ ...GOOD, SERVER_SIGNING_SECRET: "S" + "A".repeat(55) }).ok).toBe(true);
  });

  it("warns on a valid seed wrapped in whitespace, which the API refuses to boot on", () => {
    const res = find({ ...GOOD, SERVER_SIGNING_SECRET: "S" + "A".repeat(55) + "\n" });
    expect(res.level).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
//  Both of these were real false alarms against a healthy mainnet deployment.
//  A preflight that reports FAILED on a working system is worse than no
//  preflight: the next red run gets skimmed.
// ---------------------------------------------------------------------------

describe("evaluateHealth — multi-tenant trustline", () => {
  it("treats not_configured as correct, not as a trustline failure", () => {
    const res = evaluateHealth({
      ok: true,
      network: "public",
      usdcTrustline: { ok: false, reason: "not_configured" },
    });
    expect(blocking(res)).toEqual([]);
    expect(res.find((r) => r.id === "live:trustline")?.ok).toBe(true);
  });

  it("still blocks when the configured wallet genuinely cannot receive USDC", () => {
    const res = evaluateHealth({
      ok: true,
      network: "public",
      usdcTrustline: { ok: false, reason: "no_trustline" },
    });
    const trustline = res.find((r) => r.id === "live:trustline")!;
    expect(trustline.ok).toBe(false);
    expect(trustline.detail).toMatch(/no_trustline/);
  });
});

// ---------------------------------------------------------------------------
// checkAnchorToml (SEP-1)
// ---------------------------------------------------------------------------

const ANCHOR_ENV = {
  ...GOOD,
  OFFRAMP: "anchor",
  ANCHOR_URL: "https://api.anchor.example",
  ANCHOR_HOME_DOMAIN: "anchor.example",
};

const GOOD_TOML = `
# comment
VERSION="2.0.0"
NETWORK_PASSPHRASE="${PUBNET_PASSPHRASE}"
SIGNING_KEY="${WALLET}"
WEB_AUTH_ENDPOINT="https://api.anchor.example/auth"
KYC_SERVER="https://api.anchor.example/sep12"
TRANSFER_SERVER="https://api.anchor.example/sep6"
ANCHOR_QUOTE_SERVER="https://api.anchor.example/sep38"

[DOCUMENTATION]
ORG_NAME="Anchor Inc"

[[CURRENCIES]]
code="USDC"
issuer="${CIRCLE_USDC_ISSUER_PUBNET}"
status="live"
`;

const GOOD_INFO = JSON.stringify({ withdraw: { USDC: { enabled: true, types: { bank_account: {} } } } });

/** Serve a toml (and optionally a /info body) from a stub; records the URLs asked for. */
function stubFetch(toml: string | { status: number } | Error, info: string | { status: number } | Error = GOOD_INFO) {
  const seen: string[] = [];
  const answer = (v: string | { status: number } | Error) => {
    if (v instanceof Error) throw v;
    return typeof v === "string" ? { status: 200, body: v } : { status: v.status, body: "" };
  };
  const fetchText = async (url: string) => {
    seen.push(url);
    return answer(url.endsWith("/info") ? info : toml);
  };
  return { fetchText, seen };
}

const byId = (results: { id: string }[], id: string) => results.find((r) => r.id === id) as
  | { id: string; ok: boolean; level: string; detail: string }
  | undefined;

/** Replace or drop one top-level line of the good toml. */
const without = (key: string) => GOOD_TOML.replace(new RegExp(`^${key}=.*$`, "m"), "");

describe("parseTomlForPreflight", () => {
  it("reads top-level keys and [[CURRENCIES]] code/issuer, ignoring other tables and comments", () => {
    const { top, currencies } = parseTomlForPreflight(GOOD_TOML);
    expect(top.SIGNING_KEY).toBe(WALLET);
    expect(top.ORG_NAME).toBeUndefined();
    expect(currencies).toEqual([{ code: "USDC", issuer: CIRCLE_USDC_ISSUER_PUBNET, status: undefined }].map(({ code, issuer }) => ({ code, issuer })));
  });

  it("handles single quotes and trailing comments", () => {
    const { top } = parseTomlForPreflight("SIGNING_KEY = 'GABC' # note\nKYC_SERVER = https://x.example # y\r\n");
    expect(top.SIGNING_KEY).toBe("GABC");
    expect(top.KYC_SERVER).toBe("https://x.example");
  });
});

describe("checkAnchorToml", () => {
  it("does nothing unless OFFRAMP=anchor", async () => {
    const { fetchText, seen } = stubFetch(GOOD_TOML);
    expect(await checkAnchorToml({ ...ANCHOR_ENV, OFFRAMP: "none" }, { fetchText })).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("passes a complete pubnet toml with nothing blocking or warned", async () => {
    const { fetchText, seen } = stubFetch(GOOD_TOML);
    const results = await checkAnchorToml(ANCHOR_ENV, { fetchText });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(seen).toEqual([
      "https://anchor.example/.well-known/stellar.toml",
      "https://api.anchor.example/sep6/info",
    ]);
    expect(exitCodeFor(results)).toBe(0);
  });

  describe("fetch", () => {
    it("fails on a non-200", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch({ status: 404 }).fetchText });
      expect(results).toHaveLength(1);
      expect(byId(results, "anchor-toml:fetch")).toMatchObject({ ok: false, level: "blocking" });
    });

    it("fails when the host is unreachable", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(new Error("ENOTFOUND")).fetchText });
      expect(byId(results, "anchor-toml:fetch")).toMatchObject({ ok: false, level: "blocking" });
      expect(byId(results, "anchor-toml:fetch")?.detail).toContain("ENOTFOUND");
    });

    it("rejects an ANCHOR_HOME_DOMAIN carrying a scheme or path", async () => {
      const { fetchText, seen } = stubFetch(GOOD_TOML);
      const results = await checkAnchorToml({ ...ANCHOR_ENV, ANCHOR_HOME_DOMAIN: "https://anchor.example/x" }, { fetchText });
      expect(exitCodeFor(results)).toBe(1);
      expect(seen).toEqual([]);
    });
  });

  describe("SIGNING_KEY", () => {
    it("passes a valid key", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML).fetchText });
      expect(byId(results, "anchor-toml:signing-key")?.ok).toBe(true);
    });
    it("fails when missing", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(without("SIGNING_KEY")).fetchText });
      expect(byId(results, "anchor-toml:signing-key")).toMatchObject({ ok: false, level: "blocking" });
    });
    it("fails when not a G... key", async () => {
      const toml = GOOD_TOML.replace(WALLET, "SBADKEY");
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      expect(byId(results, "anchor-toml:signing-key")).toMatchObject({ ok: false, level: "blocking" });
    });
  });

  describe("NETWORK_PASSPHRASE", () => {
    it("passes the public network passphrase", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML).fetchText });
      expect(byId(results, "anchor-toml:network")?.ok).toBe(true);
    });
    it("fails when missing, which the runtime lets through silently", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(without("NETWORK_PASSPHRASE")).fetchText });
      expect(byId(results, "anchor-toml:network")).toMatchObject({ ok: false, level: "blocking" });
    });
    it("fails on the testnet passphrase", async () => {
      const toml = GOOD_TOML.replace(PUBNET_PASSPHRASE, "Test SDF Network ; September 2015");
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      const r = byId(results, "anchor-toml:network");
      expect(r).toMatchObject({ ok: false, level: "blocking" });
      expect(r?.detail).toContain("Test SDF Network");
    });
  });

  describe.each(["WEB_AUTH_ENDPOINT", "KYC_SERVER", "TRANSFER_SERVER", "ANCHOR_QUOTE_SERVER"])("%s", (key) => {
    const id = `anchor-toml:${key}`;
    it("passes when present on https and on the ANCHOR_URL host", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML).fetchText });
      expect(byId(results, id)?.ok).toBe(true);
    });
    // ANCHOR_QUOTE_SERVER is optional (issue 3.19): see "optional endpoints" below.
    it.skipIf(key === "ANCHOR_QUOTE_SERVER")("fails when missing", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(without(key)).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "blocking" });
    });
    it("fails when not https", async () => {
      const toml = GOOD_TOML.replace(new RegExp(`^${key}="https:`, "m"), `${key}="http:`);
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "blocking" });
    });
    it("only warns when the host differs from ANCHOR_URL", async () => {
      const toml = GOOD_TOML.replace(new RegExp(`^(${key}="https://)api\\.anchor\\.example`, "m"), "$1elsewhere.example");
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "warning" });
    });
  });

  describe("optional endpoints (issue 3.19)", () => {
    const SEP24_ONLY = GOOD_TOML.replace(
      'TRANSFER_SERVER="https://api.anchor.example/sep6"',
      'TRANSFER_SERVER_SEP0024="https://api.anchor.example/sep24"',
    ).replace(/^ANCHOR_QUOTE_SERVER=.*\n/m, "");

    it("accepts a SEP-24-only anchor with no SEP-38, warning only about the missing quote server", async () => {
      const { fetchText, seen } = stubFetch(SEP24_ONLY);
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText });
      expect(results.filter((r) => !r.ok && r.level === "blocking")).toEqual([]);
      expect(byId(results, "anchor-toml:TRANSFER_SERVER")).toBeUndefined();
      expect(byId(results, "anchor-toml:TRANSFER_SERVER_SEP0024")?.ok).toBe(true);
      expect(byId(results, "anchor-toml:ANCHOR_QUOTE_SERVER")).toMatchObject({ ok: false, level: "warning" });
      // /info is read from the SEP-24 server when there is no SEP-6 one.
      expect(seen).toContain("https://api.anchor.example/sep24/info");
    });

    it("is quiet about the quote server when OFFRAMP_RATE_SOURCE supplies the rate", async () => {
      const results = await checkAnchorToml(
        { ...ANCHOR_ENV, OFFRAMP_RATE_SOURCE: "static" },
        { fetchText: stubFetch(SEP24_ONLY).fetchText },
      );
      expect(byId(results, "anchor-toml:ANCHOR_QUOTE_SERVER")).toBeUndefined();
    });

    it("still blocks an anchor that declares neither transfer server", async () => {
      const toml = SEP24_ONLY.replace(/^TRANSFER_SERVER_SEP0024=.*\n/m, "");
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      expect(byId(results, "anchor-toml:TRANSFER_SERVER")).toMatchObject({ ok: false, level: "blocking" });
      expect(byId(results, "anchor-toml:TRANSFER_SERVER_SEP0024")).toMatchObject({ ok: false, level: "blocking" });
    });
  });

  it("accepts WEB_AUTH_URL, the alias the runtime also reads", async () => {
    const toml = GOOD_TOML.replace("WEB_AUTH_ENDPOINT=", "WEB_AUTH_URL=");
    const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
    expect(byId(results, "anchor-toml:WEB_AUTH_ENDPOINT")?.ok).toBe(true);
  });

  describe("USDC currency", () => {
    it("passes with Circle's issuer", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML).fetchText });
      expect(byId(results, "anchor-toml:usdc")?.ok).toBe(true);
    });
    it("fails when USDC is not listed", async () => {
      const toml = GOOD_TOML.replace('code="USDC"', 'code="EURC"');
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      expect(byId(results, "anchor-toml:usdc")).toMatchObject({ ok: false, level: "blocking" });
    });
    it("fails when USDC has another issuer", async () => {
      const toml = GOOD_TOML.replace(CIRCLE_USDC_ISSUER_PUBNET, "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      const r = byId(results, "anchor-toml:usdc");
      expect(r).toMatchObject({ ok: false, level: "blocking" });
      expect(r?.detail).toContain("GBBD47IF");
    });
    it("passes when Circle's USDC is one of several currencies", async () => {
      const toml = `[[CURRENCIES]]\ncode="USDC"\nissuer="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"\n` + GOOD_TOML;
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(toml).fetchText });
      expect(byId(results, "anchor-toml:usdc")?.ok).toBe(true);
    });
  });

  describe("SEP-6 /info (warnings only)", () => {
    const id = "anchor-toml:withdraw-info";
    const info = (usdc: unknown) => JSON.stringify({ withdraw: { USDC: usdc } });

    it("passes when USDC withdraw is enabled with a single type", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML, info({ enabled: true, types: { bank_account: {} } })).fetchText });
      expect(byId(results, id)?.ok).toBe(true);
    });
    it("warns when USDC withdraw is not enabled", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML, info({ enabled: false })).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "warning" });
      expect(exitCodeFor(results)).toBe(0);
    });
    it("warns when several types are offered and OFFRAMP_TYPE is unset", async () => {
      const multi = info({ enabled: true, types: { bank_account: {}, cash: {} } });
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML, multi).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "warning" });
    });
    it("passes with several types once OFFRAMP_TYPE names one", async () => {
      const multi = info({ enabled: true, types: { bank_account: {}, cash: {} } });
      const results = await checkAnchorToml({ ...ANCHOR_ENV, OFFRAMP_TYPE: "cash" }, { fetchText: stubFetch(GOOD_TOML, multi).fetchText });
      expect(byId(results, id)?.ok).toBe(true);
    });
    it("warns when OFFRAMP_TYPE is not offered", async () => {
      const results = await checkAnchorToml({ ...ANCHOR_ENV, OFFRAMP_TYPE: "wire" }, { fetchText: stubFetch(GOOD_TOML).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "warning" });
    });
    it("warns, never blocks, when /info is unreachable", async () => {
      const results = await checkAnchorToml(ANCHOR_ENV, { fetchText: stubFetch(GOOD_TOML, { status: 500 }).fetchText });
      expect(byId(results, id)).toMatchObject({ ok: false, level: "warning" });
      expect(exitCodeFor(results)).toBe(0);
    });
  });
});
