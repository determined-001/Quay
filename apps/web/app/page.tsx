import Dashboard from "./components/Dashboard";

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
      <Dashboard />
    </main>
  );
}
