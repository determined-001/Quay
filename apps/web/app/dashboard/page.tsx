import type { Metadata } from "next";
import Dashboard from "../components/Dashboard";
import Logo from "../components/Logo";
import SessionGate from "../components/SessionGate";
import ThemeToggle from "../components/ThemeToggle";
import "../dashboard.css";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  // Signed out: a quiet masthead above the connect prompt. Signed in: the app
  // shell supplies its own navigation, account and theme switch, so the gate
  // draws no strip of its own (`chrome="none"`).
  //
  // Everything inside is seller-scoped and 401s without a session, so it is
  // mounted only once the wallet has signed a SEP-10 challenge. Rendering it
  // signed-out would just fire failing requests at the user.
  return (
    <SessionGate
      chrome="none"
      header={
        <header className="masthead">
          <Logo />
          <span className="masthead__right">
            <ThemeToggle />
          </span>
        </header>
      }
    >
      <Dashboard />
    </SessionGate>
  );
}
