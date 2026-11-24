import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * env.ts validates at module load and throws, so every case re-imports it with
 * a fresh module registry rather than calling a function (issue 8.30).
 *
 * "Unset" is an empty string, never `delete`: env.ts's .env loader refills
 * undefined vars from the developer's own .env (see env-mainnet-guards.test.ts).
 */

const MAINNET_BASE: Record<string, string> = {
  STELLAR_NETWORK: "public",
  USDC_ISSUER_PUBLIC: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  KYC_ENCRYPTION_KEY: "a".repeat(64),
  OFFRAMP: "anchor",
  ANCHOR_URL: "https://anchor.example.com",
  ANCHOR_HOME_DOMAIN: "anchor.example.com",
};

let saved: NodeJS.ProcessEnv;

/** `""` means "unset" — see the note above. */
function setEnv(over: Record<string, string>): void {
  const base: Record<string, string> = {
    STELLAR_NETWORK: "testnet",
    OFFRAMP: "mock",
    PATH_PAYMENTS_ENABLED: "",
    PATH_PAYMENTS_MAX_SLIPPAGE_BPS: "",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) process.env[k] = v;
}

type Env = (typeof import("../src/env"))["env"];

/** Imports env.ts fresh, returning the thrown error or the parsed env. */
async function loadEnv(): Promise<{ env: Env } | { error: Error }> {
  vi.resetModules();
  try {
    const mod = await import("../src/env");
    return { env: mod.env };
  } catch (err) {
    return { error: err as Error };
  }
}

async function envOk(): Promise<Env> {
  const r = await loadEnv();
  if ("error" in r) throw r.error;
  return r.env;
}

async function envError(): Promise<string> {
  const r = await loadEnv();
  if (!("error" in r)) throw new Error("expected env.ts to refuse to load");
  return r.error.message;
}

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  process.env = saved;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("PATH_PAYMENTS_ENABLED (issue 8.30)", () => {
  it("is off when unset", async () => {
    setEnv({ PATH_PAYMENTS_ENABLED: "" });
    expect((await envOk()).pathPaymentsEnabled).toBe(false);
  });

  it("is on only for the exact string 'true'", async () => {
    setEnv({ PATH_PAYMENTS_ENABLED: "true" });
    expect((await envOk()).pathPaymentsEnabled).toBe(true);
  });

  it.each(["false", "1", "TRUE", "yes", ""])("is off for %j", async (value) => {
    setEnv({ PATH_PAYMENTS_ENABLED: value });
    expect((await envOk()).pathPaymentsEnabled).toBe(false);
  });

  it("is off by default on mainnet too, and boot stays quiet", async () => {
    setEnv({ ...MAINNET_BASE });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await envOk()).pathPaymentsEnabled).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/PATH_PAYMENTS_ENABLED/);
  });

  it("logs one warning when switched on for mainnet", async () => {
    setEnv({ ...MAINNET_BASE, PATH_PAYMENTS_ENABLED: "true" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await envOk()).pathPaymentsEnabled).toBe(true);
    const lines = warn.mock.calls.map((c) => c.join(" ")).filter((l) => l.includes("PATH_PAYMENTS_ENABLED"));
    expect(lines).toHaveLength(1);
  });
});

describe("PATH_PAYMENTS_MAX_SLIPPAGE_BPS (issue 8.30)", () => {
  it("defaults to 100", async () => {
    setEnv({ PATH_PAYMENTS_MAX_SLIPPAGE_BPS: "" });
    expect((await envOk()).pathPaymentsMaxSlippageBps).toBe(100);
  });

  it.each([
    ["0", 0],
    ["500", 500],
    ["1000", 1000],
  ])("accepts %s", async (raw, expected) => {
    setEnv({ PATH_PAYMENTS_MAX_SLIPPAGE_BPS: raw });
    expect((await envOk()).pathPaymentsMaxSlippageBps).toBe(expected);
  });

  it.each(["-1", "1001", "1.5", "abc", "1e2"])("refuses to boot on %j", async (raw) => {
    setEnv({ PATH_PAYMENTS_MAX_SLIPPAGE_BPS: raw });
    expect(await envError()).toMatch(/^PATH_PAYMENTS_MAX_SLIPPAGE_BPS must be an integer from 0 to 1000/);
  });
});

describe("PATH_PAYMENTS_MAX_PRICE_IMPACT_BPS (issue #547)", () => {
  it("defaults to 300", async () => {
    setEnv({ PATH_PAYMENTS_MAX_PRICE_IMPACT_BPS: "" });
    expect((await envOk()).pathPaymentsMaxPriceImpactBps).toBe(300);
  });

  it("reads an override", async () => {
    setEnv({ PATH_PAYMENTS_MAX_PRICE_IMPACT_BPS: "150" });
    expect((await envOk()).pathPaymentsMaxPriceImpactBps).toBe(150);
  });
});
