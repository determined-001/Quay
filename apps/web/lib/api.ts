import type { PaymentLink, PaymentRequest, PayoutFieldDescriptor } from "@checkout/core";

export type { PaymentLink, PaymentRequest, PayoutFieldDescriptor };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

export interface OfframpRequirements {
  /** Anchor's field descriptors — drives the dynamic form. */
  descriptors: PayoutFieldDescriptor[];
  /**
   * Previously-saved values, masked to last 4 chars. Null on first cash-out.
   * The form uses these to show "already on file" and skips fields the seller
   * leaves blank (meaning "reuse saved value").
   */
  savedFields: Record<string, string> | null;
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

  getOfframpRequirements: (id: string) =>
    http<OfframpRequirements>(`/links/${id}/offramp-requirements`),

  cashOut: (id: string, targetCurrency: string, payoutFields: Record<string, string> = {}) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }) },
    ),
};
