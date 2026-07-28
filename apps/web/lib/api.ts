import type { PaymentLink, PaymentRequest } from "@checkout/core";

export type { PaymentLink, PaymentRequest };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

/** A webhook delivery record for timeline display. */
export interface WebhookDelivery {
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

export interface LinkDetail {
  link: PaymentLink;
  request: PaymentRequest;
  deliveries: WebhookDelivery[];
}

/** Fields exposed on the public receipt — never includes seller PII. */
export interface PublicReceipt {
  reference: string;
  title: string;
  amount: string;
  asset: { code: string; issuer: string | null };
  status: string;
  txHash: string | null;
  payer: string | null;
  paidAmount: string | null;
  createdAt: number;
  updatedAt: number;
}

// Browser calls go to NEXT_PUBLIC_API_URL; server-side calls fall back to API_URL.
const BROWSER_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function apiBase(): string {
  if (typeof window === "undefined") {
    return process.env.API_URL ?? BROWSER_BASE;
  }
  return BROWSER_BASE;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface CreateLinkInput {
  title: string;
  amount: string;
  assetCode: "USDC" | "XLM";
  expiresInMinutes?: number;
}

export const api = {
  createLink: (input: CreateLinkInput) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input) }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  getDetail: (id: string) => http<LinkDetail>(`/links/${id}/detail`),

  getReceipt: (reference: string) => http<PublicReceipt>(`/r/${reference}`),

  cashOut: (id: string, targetCurrency: string, payoutFields: Record<string, string> = {}) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }) },
    ),

  exportCsv: async (from?: string, to?: string): Promise<Blob> => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    const res = await fetch(`${apiBase()}/links/export/csv${qs ? `?${qs}` : ""}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },
};
