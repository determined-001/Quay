import type { AssetRef } from "@checkout/core";

/**
 * The narrow Horizon surface refund confirmation needs (issue #538), and the
 * real client behind it.
 *
 * It lives in `@checkout/stellar` — next to the other Horizon code, and in the
 * package that is allowed to import a chain SDK — so callers depend on a port
 * rather than on Horizon's JSON shapes. `apps/api/src/services/reconciliation.ts`
 * re-exports it for the report it already used it for.
 */

export interface HorizonTransaction {
  successful: boolean;
  memoType: string | null;
  memo: string | null;
  /** Horizon's `result_code` (for example "tx_failed"); null when absent. */
  resultCode: string | null;
}

export interface HorizonPayment {
  from: string;
  to: string;
  amount: string;
  asset: AssetRef;
  /** The G-address behind `to` when this paid a muxed account; omitted otherwise. */
  toMuxed?: string | null;
  /** The muxed id (as a string) when this paid a muxed account; omitted otherwise. */
  toMuxedId?: string | null;
}

/** Narrow Horizon read surface; stubbed in tests. */
export interface HorizonLookup {
  /** null when Horizon answers 404 (no such transaction). Throws on any other failure. */
  getTransaction(hash: string): Promise<HorizonTransaction | null>;
  getPayments(hash: string): Promise<HorizonPayment[]>;
}

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Horizon over plain `fetch`. Read-only.
 *
 * Errors carry the HTTP status only, never a response body: Horizon bodies can
 * hold account data, and an error message ends up in logs.
 */
export function createHorizonLookup(
  horizonUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): HorizonLookup {
  const base = horizonUrl.replace(/\/+$/, "");

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error(`Horizon answered HTTP ${res.status}`);
    return { status: res.status, body: await res.json() };
  }

  return {
    async getTransaction(hash) {
      if (!HASH_RE.test(hash)) throw new Error("refusing to query a malformed hash");
      const { status, body } = await getJson(`/transactions/${hash}`);
      if (status === 404) return null;
      const t = body as {
        successful?: boolean;
        memo_type?: string;
        memo?: string;
        result_code?: string;
      };
      return {
        successful: t.successful === true,
        memoType: t.memo_type && t.memo_type !== "none" ? t.memo_type : null,
        memo: typeof t.memo === "string" ? t.memo : null,
        resultCode: typeof t.result_code === "string" ? t.result_code : null,
      };
    },

    async getPayments(hash) {
      if (!HASH_RE.test(hash)) throw new Error("refusing to query a malformed hash");
      // `/payments`, not `/operations`: it already excludes operations that
      // move no money, and it is the endpoint refund confirmation reads.
      const { status, body } = await getJson(`/transactions/${hash}/payments?limit=200`);
      if (status === 404) return [];
      const records =
        (body as { _embedded?: { records?: Array<Record<string, unknown>> } })._embedded?.records ?? [];
      const out: HorizonPayment[] = [];
      for (const r of records) {
        if (r.type !== "payment") continue;
        if (typeof r.to !== "string" || typeof r.amount !== "string") continue;
        const payment: HorizonPayment = {
          from:
            typeof r.from === "string"
              ? r.from
              : typeof r.source_account === "string"
                ? r.source_account
                : "",
          to: r.to,
          amount: r.amount,
          asset:
            r.asset_type === "native"
              ? { code: "XLM", issuer: null }
              : {
                  code: typeof r.asset_code === "string" ? r.asset_code : "",
                  issuer: typeof r.asset_issuer === "string" ? r.asset_issuer : null,
                },
        };
        if (typeof r.to_muxed === "string") payment.toMuxed = r.to_muxed;
        if (r.to_muxed_id !== undefined && r.to_muxed_id !== null) {
          payment.toMuxedId = String(r.to_muxed_id);
        }
        out.push(payment);
      }
      return out;
    },
  };
}
