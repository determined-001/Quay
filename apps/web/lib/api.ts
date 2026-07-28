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

// Session token lives ONLY in memory for the lifetime of the page — never
// localStorage/sessionStorage (a persistent, JS-readable store is exactly what
// an XSS payload would go looking for). It's lost on a hard refresh; the
// httpOnly `session` cookie the API also sets is what survives that (sent
// automatically via `credentials: "include"`, never readable by this code).
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init?.headers as Record<string, string> ?? {}) };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;

  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "include", // send the httpOnly session cookie cross-origin
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401) setSessionToken(null); // the session is no longer good for anything
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

export interface AuthChallenge {
  transaction: string;
  network_passphrase: string;
}

export const api = {
  createLink: (input: CreateLinkInput) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input) }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  cashOut: (id: string, targetCurrency: string, payoutFields: Record<string, string> = {}) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }) },
    ),

  // Wallet-native login (SEP-10): getAuthChallenge() -> sign with the wallet ->
  // submitAuthChallenge() -> setSessionToken(token) on success.
  getAuthChallenge: (account: string) => http<AuthChallenge>(`/auth?account=${encodeURIComponent(account)}`),

  submitAuthChallenge: (transaction: string) =>
    http<{ token: string; expiresAt: number }>("/auth", { method: "POST", body: JSON.stringify({ transaction }) }).then((res) => {
      setSessionToken(res.token);
      return res;
    }),

  logout: () => http<{ ok: true }>("/auth/logout", { method: "POST" }).finally(() => setSessionToken(null)),
};
