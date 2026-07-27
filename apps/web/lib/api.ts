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

/** Thrown for API error responses that carry a machine-readable `error` code
 *  (the `{ "error": "<code>", ... }` convention — see docs/API.md). `details`
 *  is everything else in the body (e.g. `reason`, `trustlineUri`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    const parsed = parseJsonObject(raw);
    if (parsed && typeof parsed.error === "string") {
      const { error: code, message, ...details } = parsed;
      throw new ApiError(res.status, code, typeof message === "string" ? message : code, details);
    }
    throw new Error(`API ${res.status}: ${raw || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface CreateLinkInput {
  title: string;
  amount: string;
  assetCode: "USDC" | "XLM";
  expiresInMinutes?: number;
}

export type UsdcTrustlineStatus =
  | { ok: true }
  | { ok: false; reason: string; message: string; trustlineUri?: string };

export interface HealthResponse {
  ok: boolean;
  network: string;
  sellerWallet: string;
  usdcTrustline: UsdcTrustlineStatus;
}

export const api = {
  createLink: (input: CreateLinkInput) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input) }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  health: () => http<HealthResponse>("/health"),

  cashOut: (id: string, targetCurrency: string, payoutFields: Record<string, string> = {}) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }) },
    ),
};
