import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
//  Quay is multi-tenant. A seller signs in with their own wallet over SEP-10,
//  that address becomes their identity AND their payout destination, and
//  `POST /links` sets `destination: seller.wallet` from the authenticated
//  seller — never from configuration.
//
//  So a deployment needs no wallet of its own, and DEFAULT_SELLER_WALLET must
//  NOT be a boot requirement on pubnet. It used to be, back when the default
//  seller was the only seller; that guard outlived the singleton it protected,
//  and requiring it implied a custody relationship this service does not have.
//
//  These tests exist so the guard cannot quietly come back.
// ---------------------------------------------------------------------------

const KEY_HEX = "a".repeat(64);
const USDC_PUBLIC = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const WALLET = "GBMDH3QWSD74ILWD2ZVFOAOCMVRNPNGAHN557WA4KABLI5IFN2XYLMGY";

let saved: NodeJS.ProcessEnv;

/** `""` means "unset" — env.ts's own loader repopulates a deleted var. */
function setPublic(over: Record<string, string> = {}): void {
  const base: Record<string, string> = {
    STELLAR_NETWORK: "public",
    USDC_ISSUER_PUBLIC: USDC_PUBLIC,
    OFFRAMP: "none",
    KYC_ENCRYPTION_KEY: KEY_HEX,
    DEFAULT_SELLER_WALLET: "",
    DEFAULT_SELLER_SECRET: "",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) process.env[k] = v;
}

async function resolveFresh() {
  vi.resetModules();
  const { resolveSellerKeypairOrWallet } = await import("../src/services/seller-wallet");
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  return { resolve: () => resolveSellerKeypairOrWallet(logger as never), logger };
}

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  process.env = saved;
  vi.resetModules();
});

describe("seller wallet resolution", () => {
  it("boots on pubnet with no DEFAULT_SELLER_WALLET — sellers bring their own", async () => {
    setPublic();
    const { resolve } = await resolveFresh();
    expect(() => resolve()).not.toThrow();
    expect(resolve().publicKey).toBeNull();
  });

  it("says why, rather than resolving to null silently", async () => {
    setPublic();
    const { resolve, logger } = await resolveFresh();
    resolve();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "seller.multi_tenant" }),
      expect.stringContaining("sellers supply their own wallet"),
    );
  });

  it("still uses a wallet when one is configured — the /health trustline signal", async () => {
    setPublic({ DEFAULT_SELLER_WALLET: WALLET });
    const { resolve } = await resolveFresh();
    expect(resolve().publicKey).toBe(WALLET);
  });

  it("still rejects a malformed wallet — optional does not mean unvalidated", async () => {
    setPublic({ DEFAULT_SELLER_WALLET: "not-a-stellar-key" });
    const { resolve } = await resolveFresh();
    expect(() => resolve()).toThrow(/not a valid Stellar G-address/);
  });

  it("never holds a key it was not given: no wallet means no keypair", async () => {
    setPublic();
    const { resolve } = await resolveFresh();
    expect(resolve().keypair).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  A malformed secret used to crash with `invalid encoded string` thrown from
//  inside the SDK's base32 decoder — no variable name, no expected shape, no
//  fix, just a stack trace pointing at strkey.js. That happened on a real
//  mainnet deploy and cost a debugging round trip.
//
//  The mistake is specific enough to name: `pnpm secrets:mainnet` prints four
//  values, three of which are 64 hex characters and one of which is a Stellar
//  seed. Pasting the wrong line is the obvious failure, so the error says so.
// ---------------------------------------------------------------------------

describe("keypairFromSecret", () => {
  async function fresh() {
    vi.resetModules();
    return (await import("../src/services/seller-wallet")).keypairFromSecret;
  }

  it("names the variable rather than blaming strkey.js", async () => {
    const keypairFromSecret = await fresh();
    expect(() => keypairFromSecret("nonsense", "SERVER_SIGNING_SECRET")).toThrow(/SERVER_SIGNING_SECRET/);
  });

  it("recognises a 64-hex value as the wrong line pasted into the wrong variable", async () => {
    const keypairFromSecret = await fresh();
    expect(() => keypairFromSecret("a".repeat(64), "SERVER_SIGNING_SECRET")).toThrow(
      /wrong line pasted into the wrong variable/,
    );
  });

  it("states the expected shape and the actual length", async () => {
    const keypairFromSecret = await fresh();
    expect(() => keypairFromSecret("SHORT", "SERVER_SIGNING_SECRET")).toThrow(
      /Expected "S" followed by 55 characters \(56 total\), got 5 character\(s\)/,
    );
  });

  it("calls out whitespace separately — a valid seed with a trailing newline is its own mistake", async () => {
    const keypairFromSecret = await fresh();
    const { Keypair } = await import("@stellar/stellar-sdk");
    const valid = Keypair.random().secret();
    expect(() => keypairFromSecret(`${valid}\n`, "SERVER_SIGNING_SECRET")).toThrow(/whitespace/);
  });

  it("accepts a real seed and returns the matching keypair", async () => {
    const keypairFromSecret = await fresh();
    const { Keypair } = await import("@stellar/stellar-sdk");
    const kp = Keypair.random();
    expect(keypairFromSecret(kp.secret(), "SERVER_SIGNING_SECRET").publicKey()).toBe(kp.publicKey());
  });
});
