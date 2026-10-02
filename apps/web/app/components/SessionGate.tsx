"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, CheckoutError, describeError } from "../../lib/api";
import { connectWallet, detectWallet, disconnectWallet, shortAddress, signChallenge } from "../../lib/wallet";

/**
 * Wallet-native login for the dashboard (issue 5.1 / 6.1).
 *
 * Every `/links`, `/webhooks` and `/seller/kyc` route is seller-scoped, so the
 * dashboard cannot do anything at all without a session. Before this existed
 * the UI rendered as though it could and every call returned 401 — the API grew
 * authentication and the web app never grew a way to authenticate.
 *
 * The flow is SEP-10 end to end:
 *
 *   connect wallet -> GET /auth?account= -> sign the challenge locally
 *   -> POST /auth -> session token
 *
 * The wallet signs a transaction that is never submitted; proving control of
 * the key IS the login. Nothing but a signature leaves the browser, and the
 * token is held in memory only (see `setSessionToken`) — so a refresh signs you
 * out, which the signed-in header says plainly rather than letting it surprise
 * anyone.
 */
export default function SessionGate({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [walletFound, setWalletFound] = useState<boolean | null>(null);

  // Warm the kit on mount rather than on click. Two things come free: the
  // dynamic import happens while the user is reading the page instead of after
  // they press the button, and extensions get the moment they need to inject
  // before anyone asks whether they exist. `null` means "still looking".
  useEffect(() => {
    let live = true;
    void detectWallet().then((found) => {
      if (live) setWalletFound(found);
    });
    return () => {
      live = false;
    };
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const account = await connectWallet();
      if (!account) return; // modal dismissed — not a failure

      const challenge = await api.getAuthChallenge(account);
      const signed = await signChallenge(challenge.transaction, account);
      await api.submitAuthChallenge(signed);
      setAddress(account);
    } catch (err) {
      // A wallet rejection reads as an error object with no HTTP shape; treat
      // anything that isn't a CheckoutError as "you declined", because that is
      // overwhelmingly what it is.
      if (err instanceof CheckoutError) setError(describeError(err));
      else setError("Signing was cancelled or the wallet is unavailable.");
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await api.logout().catch(() => {
        // Revoking server-side is best effort; dropping the local token is what
        // actually signs this browser out.
      });
      await disconnectWallet();
    } finally {
      setAddress(null);
      setBusy(false);
    }
  }, []);

  if (!address) {
    return (
      <main className="shell shell--narrow" style={{ paddingTop: 64 }}>
        <div className="panel" style={{ textAlign: "center" }}>
          <h2 style={{ fontSize: 20, marginBottom: 8, color: "var(--text)" }}>Connect your wallet</h2>
          <p className="muted" style={{ marginBottom: 20 }}>
            Your Stellar wallet is your account — there is no password and nothing to sign up for.
            You&apos;ll sign a challenge to prove you control the address; it is never submitted to
            the network and moves no funds.
          </p>

          <button className="btn" onClick={signIn} disabled={busy || walletFound === null}>
            {busy
              ? "Waiting for wallet…"
              : walletFound === null
                ? "Looking for wallets…"
                : "Connect wallet"}
          </button>

          {walletFound === false && (
            <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>
              No Stellar wallet detected in this browser.{" "}
              <a href="https://freighter.app" target="_blank" rel="noopener noreferrer">
                Freighter
              </a>{" "}
              is the usual choice. Install it, then reload this page.
            </p>
          )}

          {error && (
            <p className="muted" style={{ marginTop: 16, color: "var(--danger, #b91c1c)" }} role="alert">
              {error}
            </p>
          )}

          <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
            Payments always land in the wallet you connect. Quay never holds your funds.
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      <div
        className="panel"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <span className="muted" style={{ fontSize: 12 }}>
            Signed in as
          </span>{" "}
          <span className="mono" title={address}>
            {shortAddress(address)}
          </span>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            This session lasts until you close or refresh the tab.
          </div>
        </div>
        <button className="btn btn--ghost" onClick={signOut} disabled={busy}>
          Sign out
        </button>
      </div>
      {children}
    </>
  );
}
