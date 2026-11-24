import { api, CheckoutError } from "../../../lib/api";
import CheckoutClient from "../../components/CheckoutClient";
import Logo from "../../components/Logo";
import NetworkChip from "../../components/NetworkChip";
import { PublicErrorPanel } from "../../components/PublicErrorPanel";
import ThemeToggle from "../../components/ThemeToggle";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { id } = await params;
  const { embed } = await searchParams;
  const isEmbed = embed === "true";

  let data;
  try {
    data = await api.getLink(id);
  } catch (err) {
    // Only a real 404 means the link doesn't exist (issue 5.42). A sleeping
    // API answers 502/503 or nothing at all while it boots; telling a buyer
    // their valid link "was removed" would be false.
    const isNotFound = err instanceof CheckoutError && (err.code === "not_found" || err.status === 404);
    const isUnreachable = !isNotFound;

    return (
      <PublicErrorPanel
        isUnreachable={isUnreachable}
        isEmbed={isEmbed}
        refreshHref={`/pay/${id}`}
      />
    );
  }

  return (
    <main className={isEmbed ? "shell shell--embed" : "shell shell--narrow"}>
      {!isEmbed && (
        <header className="masthead">
          <Logo />
          <span className="masthead__right">
            {/* Which chain this payment settles on (issue 5.43): the checkout
                takes real money on mainnet and must say so. */}
            <NetworkChip />
            <span className="net mono">{data.link.asset.code}</span>
            <ThemeToggle />
          </span>
        </header>
      )}
      <div className={isEmbed ? "panel panel--embed" : "panel"}>
        <CheckoutClient initial={data} embed={isEmbed} />
      </div>
    </main>
  );
}
