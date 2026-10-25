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
   *  consecutive failures on the primary; the watcher returns to the primary
   *  only once a probe of the primary itself (every `primaryRetryMs`) succeeds. */
  fallbackServer?: HorizonClient | string;
  /** Consecutive failures before considered degraded (and before switching to
   *  the fallback, if one is configured). Default 3. */
  degradedThreshold?: number;
  /** Passed straight through to `withHorizonRetry` for every call — mainly for
   *  tests to shrink the backoff delays; production can leave this unset. */
  retryOptions?: RetryOptions;
  /** While on the fallback, how long to wait between probes of the primary.
   *  A failed probe is answered by the fallback in the same call, so it never
   *  costs a failed tick. Default 30 000 ms. */
  primaryRetryMs?: number;
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number;
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
 * set, switches to it. It leaves the fallback only after a probe of the primary
 * (one call per `primaryRetryMs`) succeeds, so a dead primary does not make
 * every other tick fail.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly primaryClient: HorizonClient;
  private readonly fallbackClient: HorizonClient | null;
  private readonly degradedThreshold: number;
  private readonly retryOptions?: RetryOptions;
  private readonly log: (msg: string) => void;
  private readonly primaryRetryMs: number;
  private readonly now: () => number;

  private usingFallback = false;
  private consecutiveFailures = 0;
  /** Earliest time at which a call may probe the primary again. */
  private nextProbeAt = 0;

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
    this.retryOptions = opts.retryOptions;
    this.log = opts.log ?? (() => {});
    this.primaryRetryMs = opts.primaryRetryMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  getStatus(): HorizonStatus {
    return {
      degraded: this.consecutiveFailures >= this.degradedThreshold,
      usingFallback: this.usingFallback,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private get client(): HorizonClient {
    return this.usingFallback && this.fallbackClient ? this.fallbackClient : this.primaryClient;
  }

  /**
   * Run one Horizon operation with retry, routing and health bookkeeping.
   * `op` builds and sends the request against the client it is handed. A 404
   * (missing account) is a legitimate, prompt answer, so it counts as a
   * success for degraded-tracking purposes and is rethrown for the caller.
   *
   * While on the fallback, a call past the cooldown tries the primary first.
   * If that probe fails the same call is served by the fallback, and the
   * failure is not counted against it.
   */
  private async run<T>(op: (client: HorizonClient) => Promise<T>): Promise<T> {
    if (this.usingFallback && this.fallbackClient && this.now() >= this.nextProbeAt) {
      try {
        const result = await withHorizonRetry(() => op(this.primaryClient), this.retryOptions);
        this.returnToPrimary();
        return result;
      } catch (err) {
        if (isNotFound(err)) {
          this.returnToPrimary();
          throw err;
        }
        this.nextProbeAt = this.now() + this.primaryRetryMs;
        this.log(`horizon_primary_probe_failed — staying on HORIZON_URL_FALLBACK: ${stringifyErr(err)}`);
      }
    }

    try {
      const result = await withHorizonRetry(() => op(this.client), this.retryOptions);
      this.onOk();
      return result;
    } catch (err) {
      if (isNotFound(err)) this.onOk();
      else this.onFail(err);
      throw err;
    }
  }

  private returnToPrimary(): void {
    this.log(
      `horizon_recovered (was on HORIZON_URL_FALLBACK) after ${this.consecutiveFailures} consecutive failure(s)`,
    );
    this.consecutiveFailures = 0;
    this.usingFallback = false;
  }

  private onOk(): void {
    if (this.consecutiveFailures > 0) {
      this.log(`horizon_recovered after ${this.consecutiveFailures} consecutive failure(s)`);
    }
    this.consecutiveFailures = 0;
  }

  private onFail(err: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.degradedThreshold) return;

    if (this.fallbackClient && !this.usingFallback) {
      this.usingFallback = true;
      this.nextProbeAt = this.now() + this.primaryRetryMs;
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures, switching to HORIZON_URL_FALLBACK: ${stringifyErr(err)}`,
      );
    } else {
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures${this.fallbackClient ? " (already on fallback)" : " (no HORIZON_URL_FALLBACK configured)"}: ${stringifyErr(err)}`,
      );
    }
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    try {
      const page = await this.run((c) =>
        c.payments().forAccount(account).order("desc").limit(1).call(),
      );
      const rec = page.records[0];
      return rec ? rec.paging_token : null;
    } catch (err) {
      if (isNotFound(err)) return null; // account not yet created on-chain
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
      page = await this.run((c) => {
        let builder = c.payments().forAccount(account).order("asc").limit(limit).join("transactions");
        if (cursor) builder = builder.cursor(cursor);
        return builder.call();
      });
    } catch (err) {
      if (isNotFound(err)) return [];
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
