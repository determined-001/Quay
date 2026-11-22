import { api, CheckoutError } from "../../../lib/api";
import CheckoutClient from "../../components/CheckoutClient";
import Logo from "../../components/Logo";
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
    const isUnreachable = err instanceof CheckoutError && err.code === "unreachable";

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
