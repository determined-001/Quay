import type { PaymentLink, PaymentRequest } from "@checkout/core";

export type { PaymentLink, PaymentRequest };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

export interface LinkWithServerTime extends LinkWithRequest {
  serverDate: Date | null;
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

/**
 * Like http(), but also returns the server's Date header for clock-skew
 * correction on the checkout countdown timer.
 */
async function httpWithServerDate<T>(path: string, init?: RequestInit): Promise<{ data: T; date: Date | null }> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  const dateHeader = res.headers.get("date");
  const date = dateHeader ? new Date(dateHeader) : null;
  const data = (await res.json()) as T;
  return { data, date };
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

  /**
   * Fetches a link and returns the server's Date header alongside the data.
   * Used by the checkout countdown timer to correct for client-clock skew.
   */
  getLinkWithServerTime: async (id: string): Promise<LinkWithServerTime> => {
    const { data, date } = await httpWithServerDate<LinkWithRequest>(`/links/${id}`);
    return { ...data, serverDate: date };
  },

  cashOut: (id: string, targetCurrency: string, payoutFields: Record<string, string> = {}) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }) },
    ),
};
