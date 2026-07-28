import type { PaymentLink, PaymentRequest } from "@checkout/core";

export type { PaymentLink, PaymentRequest };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

// Browser calls go to NEXT_PUBLIC_API_URL; server-side calls fall back to API_URL.
const BROWSER_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function apiBase(): string {
  if (typeof window === "undefined") {
    return process.env.API_URL ?? BROWSER_BASE;
  }
  return BROWSER_BASE;
}

async function http<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> ?? {}),
  };
  if (init?.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers,
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
  createLink: (input: CreateLinkInput, idempotencyKey?: string) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input), idempotencyKey }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  cashOut: (id: string, targetCurrency: string, payoutFields: Record<string, string> = {}, idempotencyKey?: string) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }), idempotencyKey },
    ),
};
