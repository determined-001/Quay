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
