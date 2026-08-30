import Dashboard from "./components/Dashboard";
import SessionGate from "./components/SessionGate";
import WebhooksPanel from "./components/WebhooksPanel";

export default function Page() {
  return (
    <main className="shell">
      <header className="masthead">
        <h1>Stellar Checkout</h1>
        <span className="net">
          <span className="dot" />
          seller dashboard
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
