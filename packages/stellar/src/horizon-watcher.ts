import type { Horizon } from "@stellar/stellar-sdk";
import type { NormalizedPayment, WatcherPort } from "@checkout/core";
import { normalizePayment, type FetchTransaction, type OperationWithTransaction } from "./normalize";
import { withHorizonRetry, type RetryOptions } from "./horizon-retry";
import { type HorizonClient, isNotFound, realHorizonClient } from "./horizon-client";

export interface HorizonStatus {
  /** True once consecutive failures have reached the degraded threshold. */
  degraded: boolean;
  /** True if currently routing calls to HORIZON_URL_FALLBACK instead of the primary. */
  usingFallback: boolean;
  consecutiveFailures: number;
}

export interface HorizonWatcherOptions {
  primaryServer: HorizonClient | string;
  /** Optional standby Horizon server. Switched to after `degradedThreshold`
   *  consecutive failures on the primary; primary is probed again after `cooldownMs`. */
  fallbackServer?: HorizonClient | string;
  /** Consecutive failures before considered degraded (and before switching to
   *  the fallback, if one is configured). Default 3. */
  degradedThreshold?: number;
  /** Milliseconds to wait while on fallback before probing the primary server again.
   *  Default 30,000 (30s). */
  cooldownMs?: number;
  /** Clock provider for measuring cooldown. Default Date.now. */
  now?: () => number;
  /** Passed straight through to `withHorizonRetry` for every call — mainly for
   *  tests to shrink the backoff delays; production can leave this unset. */
  retryOptions?: RetryOptions;
  log?: (msg: string) => void;
}

function toClient(target: HorizonClient | string): HorizonClient {
  return typeof target === "string" ? realHorizonClient(target) : target;
}

/**
 * Polling implementation of WatcherPort over Horizon.
 *
 * Polling (vs streaming) is deliberate for the MVP: it is restart-safe with a
 * persisted cursor and trivial to reason about. `StreamingHorizonWatcher`
 * satisfies the same interface for the WATCH_MODE=stream path.
 *
 * Every Horizon call goes through `withHorizonRetry` (3 attempts, exponential
 * backoff with full jitter, honoring `Retry-After` on 429) so a transient blip
 * resolves without an operator noticing. Sustained failure — retries exhausted
 * `degradedThreshold` times in a row — marks the watcher `degraded` (see
 * `getStatus()`, surfaced in `GET /health`) and, if `HORIZON_URL_FALLBACK` is
 * set, switches to it until the primary recovers after a probe.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly primaryClient: HorizonClient;
  private readonly fallbackClient: HorizonClient | null;
  private readonly degradedThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly retryOptions?: RetryOptions;
  private readonly log: (msg: string) => void;

  private usingFallback = false;
  private consecutiveFailures = 0;
  private lastProbeAt = 0;

  /** Accepts a bare Horizon URL or injected client (the original shape, still
   *  used by tests and the streaming path) or the full resilience options. */
  constructor(target: string | HorizonClient | HorizonWatcherOptions) {
    const opts: HorizonWatcherOptions =
      typeof target === "string" || !("primaryServer" in target)
        ? { primaryServer: target as string | HorizonClient }
      : target;
    this.primaryClient = toClient(opts.primaryServer);
    this.fallbackClient = opts.fallbackServer ? toClient(opts.fallbackServer) : null;
    this.degradedThreshold = opts.degradedThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
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

  private onPrimaryOk(): void {
    if (this.consecutiveFailures > 0 || this.usingFallback) {
      this.log(
        `horizon_recovered${this.usingFallback ? " (was on HORIZON_URL_FALLBACK)" : ""} after ${this.consecutiveFailures} consecutive failure(s)`,
      );
    }
    this.consecutiveFailures = 0;
    this.usingFallback = false;
  }

  private onFallbackOk(): void {
    // When fallback succeeds, we do NOT switch back to primary.
    // We only reset consecutive failures so fallback health is preserved.
    this.consecutiveFailures = 0;
  }

  private onFail(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.degradedThreshold) return;

    if (this.fallbackClient && !this.usingFallback) {
      this.usingFallback = true;
      this.lastProbeAt = this.now();
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures, switching to HORIZON_URL_FALLBACK: ${stringifyErr(err)}`,
      );
    } else {
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures${this.fallbackClient ? " (already on fallback)" : " (no HORIZON_URL_FALLBACK configured)"}: ${stringifyErr(err)}`,
      );
    }
  }

  private async executeWithFailover<T>(run: (client: HorizonClient) => Promise<T>): Promise<T> {
    // If not using fallback, or no fallback configured, execute against primary directly
    if (!this.usingFallback || !this.fallbackClient) {
      try {
        const result = await withHorizonRetry(() => run(this.primaryClient), this.retryOptions);
        this.onPrimaryOk();
        return result;
      } catch (err) {
        if (isNotFound(err)) {
          this.onPrimaryOk();
          throw err;
        }
        this.onFail(err);
        throw err;
      }
    }

    // Currently using fallback. Check if cooldown has elapsed to probe primary.
    const currentTime = this.now();
    if (currentTime - this.lastProbeAt >= this.cooldownMs) {
      this.lastProbeAt = currentTime;
      try {
        const result = await withHorizonRetry(() => run(this.primaryClient), this.retryOptions);
        this.onPrimaryOk();
        return result;
      } catch (probeErr) {
        if (isNotFound(probeErr)) {
          this.onPrimaryOk();
          throw probeErr;
        }
        // Primary probe failed. Do not count this against the fallback.
        this.log(`horizon_primary_probe_failed: ${stringifyErr(probeErr)}`);
      }
    }

    // Execute via fallback
    try {
      const result = await withHorizonRetry(() => run(this.fallbackClient!), this.retryOptions);
      this.onFallbackOk();
      return result;
    } catch (err) {
      if (isNotFound(err)) {
        this.onFallbackOk();
        throw err;
      }
      this.onFail(err);
      throw err;
    }
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await this.executeWithFailover((client) =>
        client.payments().forAccount(account).order("desc").limit(1).call(),
      );
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) {
        return null; // account not yet created on-chain
      }
      throw err;
    }
  }

  /** Value payments on this account after `cursor`, oldest-first.
   *  Includes both directions; the matcher gates correctness on destination,
   *  and the worker advances the cursor by the last token returned here.
   *
   *  `join("transactions")` has Horizon embed each payment's parent
   *  transaction in the same response, so `normalizePayment`'s memo lookup
   *  resolves from data already in hand — one Horizon request per page, not
   *  one plus N. As a second line of defense (in case a given Horizon
   *  deployment doesn't honor the join), transaction fetches are additionally
   *  memoized per distinct `transaction_hash` for the duration of this call —
   *  several payments sharing one transaction only fetch it once. */
  async fetchSince(account: string, cursor: string, limit = 200): Promise<NormalizedPayment[]> {
    // join=transactions embeds the tx (and its memo) in the same response, so a
    // page of N payments costs one Horizon request instead of 1+N (issue #11).
    let page;
    try {
      page = await this.executeWithFailover((client) => {
        let builder = client
          .payments()
          .forAccount(account)
          .order("asc")
          .limit(limit)
          .join("transactions");
        if (cursor) builder = builder.cursor(cursor);
        return builder.call();
      });
    } catch (err) {
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }

    const txCache = new Map<string, Promise<Horizon.ServerApi.TransactionRecord>>();
    const fetchTransaction: FetchTransaction = (record: OperationWithTransaction) => {
      let pending = txCache.get(record.transaction_hash);
      if (!pending) {
        pending = record.transaction();
        txCache.set(record.transaction_hash, pending);
      }
      return pending;
    };

    // Deliberately not caught here: a transaction-fetch failure must not be
    // downgraded to a payment with no memo (that would silently park a
    // matchable payment as unmatched). Throwing lets the whole page fail, so
    // the caller's cursor doesn't advance and the next tick retries it.
    const out: NormalizedPayment[] = [];
    for (const record of page.records) {
      const normalized = await normalizePayment(record, fetchTransaction);
      if (normalized) out.push(normalized);
    }
    return out;
  }
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
