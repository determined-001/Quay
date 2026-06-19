import { Horizon } from "@stellar/stellar-sdk";
import type { NormalizedPayment, WatcherPort } from "@checkout/core";
import { normalizePayment } from "./normalize";

/**
 * Polling implementation of WatcherPort over Horizon.
 *
 * Polling (vs streaming) is deliberate for the MVP: it is restart-safe with a
 * persisted cursor and trivial to reason about. A streaming impl can satisfy the
 * same interface later without touching the domain or the worker loop.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly server: Horizon.Server;

  constructor(horizonUrl: string) {
    this.server = new Horizon.Server(horizonUrl);
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await this.server
        .payments()
        .forAccount(account)
        .order("desc")
        .limit(1)
        .call();
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) return null; // account not yet created on-chain
      throw err;
    }
  }

  /** Value payments on this account after `cursor`, oldest-first.
   *  Includes both directions; the matcher gates correctness on destination,
   *  and the worker advances the cursor by the last token returned here. */
  async fetchSince(account: string, cursor: string, limit = 200): Promise<NormalizedPayment[]> {
    let builder = this.server.payments().forAccount(account).order("asc").limit(limit);
    if (cursor) builder = builder.cursor(cursor);

    let page;
    try {
      page = await builder.call();
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }

    const out: NormalizedPayment[] = [];
    for (const record of page.records) {
      const normalized = await normalizePayment(record);
      if (normalized) out.push(normalized);
    }
    return out;
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}
