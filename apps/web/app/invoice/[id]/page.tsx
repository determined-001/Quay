import type { Metadata } from "next";
import { api, CheckoutError, type LinkWithRequest, type PublicInvoice } from "../../../lib/api";
import { stellarNetwork } from "../../../lib/explorer";
import { PublicErrorPanel } from "../../components/PublicErrorPanel";
import { InvoiceView } from "./InvoiceView";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (process.env.NEXT_PUBLIC_INVOICES_ENABLED !== "true") {
    return { title: "Invoice not found" };
  }

  try {
    const invoice = await api.getPublicInvoice(id);
    const seller = invoice.sellerName ?? invoice.sellerDisplayName ?? invoice.seller ?? "Seller";
    const title = `Invoice ${invoice.number} from ${seller}`;
    return {
      title,
      openGraph: {
        title,
        description: `Invoice ${invoice.number} from ${seller}`,
      },
    };
  } catch {
    return { title: "Invoice not found" };
  }
}

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (process.env.NEXT_PUBLIC_INVOICES_ENABLED !== "true") {
    return <PublicErrorPanel refreshHref={`/invoice/${id}`} />;
  }

  let invoice: PublicInvoice;
  try {
    invoice = await api.getPublicInvoice(id);
  } catch (err) {
    const isUnreachable = err instanceof CheckoutError && err.code === "unreachable";
    return <PublicErrorPanel isUnreachable={isUnreachable} refreshHref={`/invoice/${id}`} />;
  }

  let linkData: LinkWithRequest | null = null;
  if (invoice.linkId) {
    try {
      linkData = await api.getLink(invoice.linkId);
    } catch {
      // link could not be fetched
    }
  }

  const isTestnet = stellarNetwork() !== "public";

  return <InvoiceView invoice={invoice} linkData={linkData} isTestnet={isTestnet} />;
}
