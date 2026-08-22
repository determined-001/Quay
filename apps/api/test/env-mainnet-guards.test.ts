import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * env.ts validates at module load and throws, so every case here re-imports it
 * with a fresh module registry rather than calling a function.
 *
 * "Unset" is expressed as an empty string, never `delete`. env.ts calls its own
 * .env loader on import, and that loader fills any var that is `undefined` —
 * so a deleted var is repopulated from the developer's real .env and the test
 * passes or fails depending on whose machine it runs on. An empty string is
 * already defined (the loader leaves it alone) and `req()` rejects it exactly
 * like a missing one, which is the behaviour under test.
 */

const KEY_HEX = "a".repeat(64);
const USDC_PUBLIC = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

let saved: NodeJS.ProcessEnv;

/** `""` means "unset" — see the note above. */
function setPublicBase(over: Record<string, string> = {}): void {
  const base: Record<string, string> = {
    STELLAR_NETWORK: "public",
    USDC_ISSUER_PUBLIC: USDC_PUBLIC,
    KYC_ENCRYPTION_KEY: KEY_HEX,
    OFFRAMP: "anchor",
    ANCHOR_URL: "https://anchor.example.com",
    ANCHOR_HOME_DOMAIN: "anchor.example.com",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) {
    process.env[k] = v;
  }
}

/** Imports env.ts fresh, returning the thrown error (or null on success). */
async function loadEnv(): Promise<Error | null> {
  vi.resetModules();
  try {
    await import("../src/env");
    return null;
  } catch (err) {
    return err as Error;
  }
}

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  process.env = saved;
  vi.resetModules();
});

describe("mainnet guardrails in env.ts", () => {
  it("refuses to boot with OFFRAMP=mock on public network", async () => {
    setPublicBase({ OFFRAMP: "mock", ANCHOR_URL: "", ANCHOR_HOME_DOMAIN: "" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/OFFRAMP=mock on public network/);
  });

  it("refuses to boot with OFFRAMP=testanchor on public network", async () => {
    setPublicBase({ OFFRAMP: "testanchor", ANCHOR_URL: "", ANCHOR_HOME_DOMAIN: "" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/testanchor\.stellar\.org is the/);
  });

  it("requires ANCHOR_URL when OFFRAMP=anchor", async () => {
    setPublicBase({ ANCHOR_URL: "" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/Missing required env var: ANCHOR_URL/);
  });

  it("requires ANCHOR_HOME_DOMAIN when OFFRAMP=anchor", async () => {
    setPublicBase({ ANCHOR_HOME_DOMAIN: "" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/Missing required env var: ANCHOR_HOME_DOMAIN/);
  });

  it("rejects a plaintext-http ANCHOR_URL on public network", async () => {
    setPublicBase({ ANCHOR_URL: "http://anchor.example.com" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/ANCHOR_URL must be https/);
  });

  it("requires USDC_ISSUER_PUBLIC on public network", async () => {
    setPublicBase({ USDC_ISSUER_PUBLIC: "" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/Missing required env var: USDC_ISSUER_PUBLIC/);
  });

  it("requires KYC_ENCRYPTION_KEY once a real anchor is configured", async () => {
    setPublicBase({ KYC_ENCRYPTION_KEY: "" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/Missing required env var: KYC_ENCRYPTION_KEY/);
  });

  it("accepts a fully configured public-network deployment", async () => {
    setPublicBase();
    expect(await loadEnv()).toBeNull();
  });

  it("accepts OFFRAMP=none on public network", async () => {
    // The safest pubnet configuration this service has: no anchor to trust, no
    // SEP-12 PII held, and no seller secret key on the server at all.
    setPublicBase({ OFFRAMP: "none", ANCHOR_URL: "", ANCHOR_HOME_DOMAIN: "", KYC_ENCRYPTION_KEY: "" });
    expect(await loadEnv()).toBeNull();
  });

  it("does not require a KYC encryption key when OFFRAMP=none", async () => {
    setPublicBase({ OFFRAMP: "none", ANCHOR_URL: "", ANCHOR_HOME_DOMAIN: "", KYC_ENCRYPTION_KEY: "" });
    vi.resetModules();
    const { env } = await import("../src/env");
    expect(env.offramp).toBe("none");
    expect(env.kycEncryptionKey).toBeUndefined();
  });

  it("rejects an unknown OFFRAMP value", async () => {
    setPublicBase({ OFFRAMP: "wire-transfer" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/OFFRAMP must be one of "mock", "testanchor", "anchor", "none"/);
  });

  it("leaves testnet alone — mock is still the offline-safe default there", async () => {
    setPublicBase({
      STELLAR_NETWORK: "testnet",
      OFFRAMP: "mock",
      ANCHOR_URL: "",
      ANCHOR_HOME_DOMAIN: "",
      KYC_ENCRYPTION_KEY: "",
      USDC_ISSUER_PUBLIC: "",
    });
    expect(await loadEnv()).toBeNull();
  });

  it("defaults trustProxyHops to 1 on public network (Render's edge proxy)", async () => {
    setPublicBase({ TRUST_PROXY_HOPS: "" });
    vi.resetModules();
    const { env } = await import("../src/env");
    expect(env.trustProxyHops).toBe(1);
    expect(env.network).toBe("public");
    expect(env.usdcIssuer).toBe(USDC_PUBLIC);
  });

  it("treats a blank numeric var as unset rather than as zero", async () => {
    // A variable declared-but-blank in a hosting dashboard used to yield 0 here,
    // silently turning off proxy trust and collapsing every client into one
    // rate-limit bucket keyed on the edge IP.
    setPublicBase({ TRUST_PROXY_HOPS: "   ", WATCH_POLL_MS: "" });
    vi.resetModules();
    const { env } = await import("../src/env");
    expect(env.trustProxyHops).toBe(1);
    expect(env.pollMs).toBe(6000);
  });

  it("refuses to boot on a non-numeric numeric var instead of yielding NaN", async () => {
    // setInterval(NaN) is a tight loop against Horizon, not a slow poll.
    setPublicBase({ WATCH_POLL_MS: "6 seconds" });
    const err = await loadEnv();
    expect(err?.message).toMatch(/WATCH_POLL_MS must be a number, got "6 seconds"/);
  });

  it("leaves SOROBAN_RPC_URL undefined on public network rather than defaulting to testnet", async () => {
    setPublicBase({ SOROBAN_RPC_URL: "" });
    vi.resetModules();
    const { env } = await import("../src/env");
    expect(env.sorobanRpcUrl).toBeUndefined();
  });
});
