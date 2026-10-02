"use client";

/**
 * Stellar Wallets Kit, wrapped so the rest of the app never imports it directly.
 *
 * Two reasons for the wrapper:
 *
 *  - The kit touches `window` at import time, so it cannot be pulled in during
 *    Next's server render. Every entry point here loads it lazily, inside a
 *    browser event, and the module is never referenced at module scope.
 *  - Its surface went static in v2 (`StellarWalletsKit.authModal()` rather than
 *    `new StellarWalletsKit(...)`). Keeping that behind one file means a future
 *    version bump is a change here, not across the UI.
 */

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "public" ? "public" : "testnet";

export const NETWORK_PASSPHRASE =
  NETWORK === "public"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

type Kit = typeof import("@creit.tech/stellar-wallets-kit/sdk").StellarWalletsKit;

let ready: Promise<Kit> | null = null;

/** Loads and initialises the kit exactly once per page. */
async function kit(): Promise<Kit> {
  if (!ready) {
    ready = (async () => {
      // v2 has no `allowAllModules()`; each wallet is its own subpath import.
      // Listed explicitly rather than pulled in wholesale — every module here
      // is browser-facing code shipped to the buyer, and the hardware-wallet
      // and WalletConnect modules are large and pull in dependencies this app
      // has no use for.
      const [mod, networks, freighter, xbull, albedo, rabet, lobstr, hana] = await Promise.all([
        import("@creit.tech/stellar-wallets-kit/sdk"),
        import("@creit.tech/stellar-wallets-kit/types"),
        import("@creit.tech/stellar-wallets-kit/modules/freighter"),
        import("@creit.tech/stellar-wallets-kit/modules/xbull"),
        import("@creit.tech/stellar-wallets-kit/modules/albedo"),
        import("@creit.tech/stellar-wallets-kit/modules/rabet"),
        import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
        import("@creit.tech/stellar-wallets-kit/modules/hana"),
      ]);

      mod.StellarWalletsKit.init({
        modules: [
          new freighter.FreighterModule(),
          new xbull.xBullModule(),
          new albedo.AlbedoModule(),
          new rabet.RabetModule(),
          new lobstr.LobstrModule(),
          new hana.HanaModule(),
        ],
        network: NETWORK === "public" ? networks.Networks.PUBLIC : networks.Networks.TESTNET,
      });
      return mod.StellarWalletsKit;
    })();
  }
  return ready;
}

/** How long to keep re-checking for a wallet before opening the picker anyway. */
const DETECT_TIMEOUT_MS = 2_500;
const DETECT_INTERVAL_MS = 150;

/**
 * Waits for at least one wallet to report itself installed.
 *
 * Browser wallets inject their provider asynchronously *after* page load, and
 * the kit computes availability once, when asked. Open the picker too early and
 * Freighter and Lobstr both show "Install" even though they are right there —
 * the check ran before the extension had announced itself. Waiting a moment and
 * re-asking is the difference between the picker being right and being wrong.
 *
 * Bounded, and never fatal: if nothing turns up within the timeout the picker
 * opens regardless, showing install links, which is the correct outcome for
 * someone who genuinely has no wallet.
 */
async function waitForWallet(k: Kit): Promise<void> {
  const deadline = Date.now() + DETECT_TIMEOUT_MS;
  for (;;) {
    try {
      const wallets = await k.refreshSupportedWallets();
      if (wallets.some((w) => w.isAvailable)) return;
    } catch {
      // Detection itself failing is not a reason to block the picker.
      return;
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, DETECT_INTERVAL_MS));
  }
}

/**
 * Opens the wallet picker and returns the chosen address.
 *
 * Resolves `null` when the user closes the modal without picking — a dismissed
 * dialog is not an error, and surfacing it as one puts a red banner in front of
 * someone who simply changed their mind.
 */
export async function connectWallet(): Promise<string | null> {
  const k = await kit();
  await waitForWallet(k);
  try {
    const { address } = await k.authModal();
    return address || null;
  } catch {
    return null;
  }
}

/**
 * Whether any wallet is currently detectable, after giving extensions time to
 * inject. Lets the UI say "no wallet detected" up front instead of only after
 * someone clicks and meets a list of install links.
 */
export async function detectWallet(): Promise<boolean> {
  const k = await kit();
  await waitForWallet(k);
  try {
    return (await k.refreshSupportedWallets()).some((w) => w.isAvailable);
  } catch {
    return false;
  }
}

/** Signs a SEP-10 challenge. Returns the signed XDR to post back to /auth. */
export async function signChallenge(xdr: string, address: string): Promise<string> {
  return signTransaction(xdr, address);
}

/** Signs an unsigned transaction with the already-selected wallet. */
export async function signTransaction(xdr: string, address: string): Promise<string> {
  const k = await kit();
  const { signedTxXdr } = await k.signTransaction(xdr, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  return signedTxXdr;
}

/** Reads the selected wallet's network so a wallet cannot sign for another chain. */
export async function getWalletNetwork(): Promise<{ network: string; networkPassphrase: string }> {
  const k = await kit();
  return k.getNetwork();
}

/** Forgets the wallet selection. Independent of the API session. */
export async function disconnectWallet(): Promise<void> {
  const k = await kit();
  await k.disconnect().catch(() => {
    // Some modules have nothing to disconnect from; the local session is
    // cleared by the caller regardless, so this must not throw.
  });
}

/** `GABC…WXYZ` — addresses are 56 chars and unreadable in full in a header. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
