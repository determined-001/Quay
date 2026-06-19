import Link from "next/link";
import { api } from "../../../lib/api";
import CheckoutClient from "../../components/CheckoutClient";

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data;
  try {
    data = await api.getLink(id);
  } catch {
    return (
      <main className="shell shell--narrow">
        <div className="panel checkout">
          <p className="title">Payment link not found</p>
          <p className="muted">This link may have been removed, or the id is wrong.</p>
          <Link className="linkbtn" href="/">
            Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell--narrow">
      <header className="masthead">
        <h1>Stellar Checkout</h1>
        <span className="net mono">{data.link.asset.code}</span>
      </header>
      <div className="panel">
        <CheckoutClient initial={data} />
      </div>
    </main>
  );
}
