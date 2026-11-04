"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { shortAddress } from "../../../lib/wallet";
import Logo from "../Logo";
import { useSellerSession } from "../SessionGate";
import ThemeToggle from "../ThemeToggle";
import { OFFRAMP_ENABLED } from "./config";
import { CashOutIcon, CodeIcon, HomeIcon, PaymentsIcon, PlusIcon, SettingsIcon } from "./icons";

export type View = "home" | "payments" | "cashout" | "settings" | "developers";

interface NavItem {
  id: View;
  label: string;
  icon: ReactNode;
}

// "Cash out" is only a destination where the deployment can do it. On a
// payments-only deployment a menu item that leads to "not available" is noise.
const MAIN_ITEMS: NavItem[] = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "payments", label: "Payments", icon: <PaymentsIcon /> },
  ...(OFFRAMP_ENABLED ? [{ id: "cashout" as const, label: "Cash out", icon: <CashOutIcon /> }] : []),
  { id: "settings", label: "Settings", icon: <SettingsIcon /> },
];

const DEVELOPERS: NavItem = { id: "developers", label: "Developers", icon: <CodeIcon /> };

/** A stable colour from the address, so the same seller always sees the same avatar. */
function avatarHue(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

/**
 * The page frame for a signed-in seller: navigation, who is signed in, and a
 * way out. It owns no data; the dashboard passes the view and handlers down.
 *
 * Navigation is buttons with `aria-current`, not tabs: these are destinations
 * of the app, and the selected one is "the current page", which is what the
 * attribute means.
 */
export default function Shell({
  view,
  onNavigate,
  onCreate,
  children,
}: {
  view: View;
  onNavigate: (v: View) => void;
  onCreate: () => void;
  children: ReactNode;
}) {
  const session = useSellerSession();
  const address = session?.address ?? null;

  const item = (n: NavItem, className: string) => (
    <button
      key={n.id}
      type="button"
      className={className}
      aria-current={view === n.id ? "page" : undefined}
      onClick={() => onNavigate(n.id)}
    >
      {n.icon}
      <span>{n.label}</span>
    </button>
  );

  return (
    <div className="app">
      <a className="skip" href="#app-main">
        Skip to content
      </a>

      <aside className="app__side" aria-label="Quay">
        <div className="app__brand">
          <Logo href="/" size={26} />
        </div>

        <nav className="nav" aria-label="Dashboard">
          {MAIN_ITEMS.map((n) => item(n, "nav__item"))}
        </nav>

        <div className="app__foot">
          <nav className="nav" aria-label="Tools">
            {item(DEVELOPERS, "nav__item nav__item--quiet")}
          </nav>

          <div className="account">
            <span
              className="account__avatar"
              aria-hidden
              style={address ? { background: `hsl(${avatarHue(address)} 38% 34%)` } : undefined}
            />
            <div className="account__meta">
              <span className="account__addr" title={address ?? undefined}>
                {address ? shortAddress(address) : "Not signed in"}
              </span>
              <span className="account__note">Your wallet</span>
            </div>
            {session && (
              <button type="button" className="account__out" onClick={session.signOut} disabled={session.busy}>
                Sign out
              </button>
            )}
          </div>

          <div className="app__tools">
            <ThemeToggle />
            <span className="app__links">
              <Link href="/privacy">Privacy</Link>
              <a href="https://github.com/determined-001/Quay" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </span>
          </div>
        </div>
      </aside>

      <div className="app__body">
        <header className="app__top">
          <Logo href="/" size={24} />
          <button type="button" className="btn btn--primary btn--sm" onClick={onCreate}>
            <PlusIcon /> New link
          </button>
        </header>

        <main id="app-main" className="app__main" tabIndex={-1}>
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Dashboard">
        {MAIN_ITEMS.map((n) => item(n, "tabbar__item"))}
      </nav>
    </div>
  );
}
