"use client";

import Link from "next/link";
import { useState } from "react";
import ErasePanel from "../ErasePanel";
import { useSellerSession } from "../SessionGate";
import ThemeToggle from "../ThemeToggle";
import { CheckIcon, CodeIcon, CopyIcon } from "./icons";
import type { View } from "./Shell";

export default function SettingsView({ onNavigate }: { onNavigate: (v: View) => void }) {
  const session = useSellerSession();
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the address stays selectable on screen.
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="page-head__sub">Your account, your data, and the tools for connecting Quay to your own site.</p>
        </div>
      </header>

      <section className="card" aria-labelledby="acct-h">
        <h2 id="acct-h">Your account</h2>
        <p className="card__hint">
          Your wallet is your account. There is no password, and payments always land in this wallet.
        </p>
        <div className="kv">
          <span className="kv__k">Wallet address</span>
          <span className="kv__v">
            <code className="addr">{session?.address ?? "Not signed in"}</code>
            {session && (
              <button type="button" className="chip" onClick={copyAddress}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </span>
        </div>
        <p className="card__hint">This session lasts until you close or refresh the tab.</p>
        {session && (
          <button type="button" className="btn" onClick={session.signOut} disabled={session.busy}>
            Sign out
          </button>
        )}
      </section>

      <section className="card appearance" aria-labelledby="look-h">
        <div>
          <h2 id="look-h">Appearance</h2>
          <p className="card__hint">Match your device, or pick light or dark.</p>
        </div>
        <ThemeToggle />
      </section>

      <section className="card link-card" aria-labelledby="dev-h">
        <span className="link-card__icon" aria-hidden>
          <CodeIcon />
        </span>
        <div className="link-card__body">
          <h2 id="dev-h">Developers</h2>
          <p className="card__hint">API keys, webhooks and CSV exports, for connecting Quay to your own store or books.</p>
        </div>
        <button type="button" className="btn" onClick={() => onNavigate("developers")}>
          Open
        </button>
      </section>

      <ErasePanel />

      <p className="fine fine--center">
        <Link href="/privacy">Privacy notice</Link>
      </p>
    </>
  );
}
