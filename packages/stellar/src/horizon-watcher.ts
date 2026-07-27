import { Horizon } from "@stellar/stellar-sdk";
import type { NormalizedPayment, WatcherPort } from "@checkout/core";
import { normalizePayment } from "./normalize";
import { withHorizonRetry, type RetryOptions } from "./horizon-retry";

export interface HorizonStatus {
  /** True once consecutive failures have reached the degraded threshold. */
  degraded: boolean;
  /** True if currently routing calls to HORIZON_URL_FALLBACK instead of the primary. */
  usingFallback: boolean;
  consecutiveFailures: number;
}

export interface HorizonWatcherOptions {
  primaryServer: Horizon.Server;
  /** Optional standby Horizon server. Switched to after `degradedThreshold`
   *  consecutive failures on the primary; switched back on the next success. */
  fallbackServer?: Horizon.Server;
  /** Consecutive failures before considered degraded (and before switching to
   *  the fallback, if one is configured). Default 3. */
  degradedThreshold?: number;
  /** Passed straight through to `withHorizonRetry` for every call — mainly for
   *  tests to shrink the backoff delays; production can leave this unset. */
  retryOptions?: RetryOptions;
  log?: (msg: string) => void;
}

/**
 * Polling implementation of WatcherPort over Horizon.
 *
 * Polling (vs streaming) is deliberate for the MVP: it is restart-safe with a
 * persisted cursor and trivial to reason about. A streaming impl can satisfy the
 * same interface later without touching the domain or the worker loop.
 *
 * Every Horizon call goes through `withHorizonRetry` (3 attempts, exponential
 * backoff with full jitter, honoring `Retry-After` on 429) so a transient blip
 * resolves without an operator noticing. Sustained failure — retries exhausted
 * `degradedThreshold` times in a row — marks the watcher `degraded` (see
 * `getStatus()`, surfaced in `GET /health`) and, if `HORIZON_URL_FALLBACK` is
 * set, switches to it until the next successful call.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly primaryServer: Horizon.Server;
  private readonly fallbackServer: Horizon.Server | null;
  private readonly degradedThreshold: number;
  private readonly retryOptions?: RetryOptions;
  private readonly log: (msg: string) => void;

  private usingFallback = false;
  private consecutiveFailures = 0;

  constructor(opts: HorizonWatcherOptions) {
    this.primaryServer = opts.primaryServer;
    this.fallbackServer = opts.fallbackServer ?? null;
    this.degradedThreshold = opts.degradedThreshold ?? 3;
    this.retryOptions = opts.retryOptions;
    this.log = opts.log ?? (() => {});
  }

  getStatus(): HorizonStatus {
    return {
      degraded: this.consecutiveFailures >= this.degradedThreshold,
      usingFallback: this.usingFallback,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private get server(): Horizon.Server {
    return this.usingFallback && this.fallbackServer ? this.fallbackServer : this.primaryServer;
  }

  /** A 404 (missing account) is a legitimate, prompt answer — not a Horizon
   *  problem — so it counts as a success for degraded-tracking purposes. */
  private onOk(): void {
    if (this.consecutiveFailures > 0 || this.usingFallback) {
      this.log(
        `horizon_recovered${this.usingFallback ? " (was on HORIZON_URL_FALLBACK)" : ""} after ${this.consecutiveFailures} consecutive failure(s)`,
      );
    }
    this.consecutiveFailures = 0;
    this.usingFallback = false;
  }

  private onFail(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.degradedThreshold) return;

    if (this.fallbackServer && !this.usingFallback) {
      this.usingFallback = true;
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures, switching to HORIZON_URL_FALLBACK: ${stringifyErr(err)}`,
      );
    } else {
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures${this.fallbackServer ? " (already on fallback)" : " (no HORIZON_URL_FALLBACK configured)"}: ${stringifyErr(err)}`,
      );
    }
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await withHorizonRetry(
        () => this.server.payments().forAccount(account).order("desc").limit(1).call(),
        this.retryOptions,
      );
      this.onOk();
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) {
        this.onOk();
        return null; // account not yet created on-chain
      }
      this.onFail(err);
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
      page = await withHorizonRetry(() => builder.call(), this.retryOptions);
      this.onOk();
    } catch (err) {
      if (isNotFound(err)) {
        this.onOk();
        return [];
      }
      this.onFail(err);
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

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
