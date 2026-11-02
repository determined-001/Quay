import type { Metadata } from "next";
import Dashboard from "../components/Dashboard";
import Logo from "../components/Logo";
import SessionGate from "../components/SessionGate";
import ThemeToggle from "../components/ThemeToggle";
import WebhooksPanel from "../components/WebhooksPanel";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <main className="shell">
      <header className="masthead">
        <Logo />
        <span className="masthead__right">
          <span className="net">
            <span className="dot" />
            seller dashboard
          </span>
          <ThemeToggle />
        </span>
      </header>
      {/* Everything below is seller-scoped and 401s without a session, so it is
          mounted only once the wallet has signed a SEP-10 challenge. Rendering
          it signed-out would just fire failing requests at the user. */}
      <SessionGate>
        <Dashboard />
        <WebhooksPanel />
      </SessionGate>
    </main>
  );
}
