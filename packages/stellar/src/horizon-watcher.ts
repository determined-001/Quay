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
   *  consecutive failures on the primary. Left only once the primary itself
   *  answers a probe — a success served by the fallback is no evidence about
   *  the primary, and treating it as such made the watcher alternate between
   *  the two for as long as the primary stayed down (issue 2.8). */
  fallbackServer?: HorizonClient | string;
  /** Consecutive failures before considered degraded (and before switching to
   *  the fallback, if one is configured). Default 3. */
  degradedThreshold?: number;
  /**
   * How long to stay on the fallback before spending one call on a probe of
   * the primary, in ms. Default 60000 — ten of the default 6s watch ticks, so
   * a single failed probe cannot dominate the tick mix. Only used when a
   * `fallbackServer` is configured. */
  primaryProbeIntervalMs?: number;
  /** Clock, injected so the cooldown is testable without real waits.
   *  Defaults to `Date.now`. */
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
 * set, switches to it.
 *
 * The watcher leaves the fallback only when the *primary* answers a probe,
 * which it attempts once per `primaryProbeIntervalMs`. A call served by the
 * fallback is deliberately not treated as primary recovery: doing so meant a
 * primary that stayed down produced `FAIL, ok, FAIL, ok, …` forever — half the
 * ticks thrown away and the failure logs never quiet — while a working server
 * sat right there (issue 2.8). A probe that fails is silent and counted
 * nowhere: it is not a call the consumer lost, merely the watcher looking.
 */
export class HorizonWatcher implements WatcherPort {
  private readonly primaryClient: HorizonClient;
  private readonly fallbackClient: HorizonClient | null;
  private readonly degradedThreshold: number;
  private readonly primaryProbeIntervalMs: number;
  private readonly now: () => number;
  private readonly retryOptions?: RetryOptions;
  private readonly log: (msg: string) => void;

  private usingFallback = false;
  private consecutiveFailures = 0;
  /** When the fallback was entered, and re-armed by each probe, in `now()` ms.
   *  `null` while serving from the primary. */
  private fallbackSince: number | null = null;

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
    this.primaryProbeIntervalMs = opts.primaryProbeIntervalMs ?? 60_000;
    this.now = opts.now ?? Date.now;
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

  /**
   * Which server this call goes to, and whether it is a probe of the primary.
   *
   * While on the fallback the watcher still checks the primary once per
   * `primaryProbeIntervalMs`. The clock is re-armed when the probe is *taken*,
   * not when its outcome is known, so a failed probe costs exactly one tick and
   * the next interval is spent back on the fallback.
   */
  private pickServer(): { client: HorizonClient; probe: boolean } {
    if (!this.usingFallback || !this.fallbackClient) {
      return { client: this.primaryClient, probe: false };
    }
    const now = this.now();
    if (this.fallbackSince !== null && now - this.fallbackSince >= this.primaryProbeIntervalMs) {
      this.fallbackSince = now;
      return { client: this.primaryClient, probe: true };
    }
    return { client: this.fallbackClient, probe: false };
  }

  /** A 404 (missing account) is a legitimate, prompt answer — not a Horizon
   *  problem — so it counts as a success for degraded-tracking purposes. */
  private onOk(probe: boolean): void {
    if (this.usingFallback && !probe) {
      // The fallback answered. That says nothing about the primary, so the
      // failure count and the fallback seat both stand until a probe passes.
      return;
    }
    if (probe) {
      this.log(
        `horizon_recovered (was on HORIZON_URL_FALLBACK) — primary answered the probe after ${this.consecutiveFailures} consecutive failure(s)`,
      );
      this.usingFallback = false;
      this.fallbackSince = null;
    } else if (this.consecutiveFailures > 0) {
      this.log(`horizon_recovered after ${this.consecutiveFailures} consecutive failure(s)`);
    }
    this.consecutiveFailures = 0;
  }

  private onFail(err: unknown, probe: boolean): void {
    if (probe) {
      // The primary is still down, but the fallback is covering for it: nothing
      // a consumer asked for failed, so there is no failure to count and no
      // recovery to announce. Silence here is what stops the log noise.
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.degradedThreshold) return;

    if (this.fallbackClient && !this.usingFallback) {
      this.usingFallback = true;
      this.fallbackSince = this.now();
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures, switching to HORIZON_URL_FALLBACK: ${stringifyErr(err)}`,
      );
    } else {
      this.log(
        `horizon_degraded — ${this.consecutiveFailures} consecutive failures${this.fallbackClient ? " (already on fallback)" : " (no HORIZON_URL_FALLBACK configured)"}: ${stringifyErr(err)}`,
      );
    }
  }

  /**
   * One logical read against Horizon, including failover bookkeeping.
   *
   * Returns `null` when Horizon answered 404 — an account with no history is an
   * answer, not a failure. Throws only when the server that was supposed to
   * answer could not.
   *
   * A failed probe of the primary is retried once on the fallback, so looking
   * at the primary never costs a consumer the call they asked for.
   */
  private async read<T>(build: (client: HorizonClient) => Promise<T>): Promise<T | null> {
    for (;;) {
      const { client, probe } = this.pickServer();
      try {
        const value = await withHorizonRetry(() => build(client), this.retryOptions);
        this.onOk(probe);
        return value;
      } catch (err) {
        if (isNotFound(err)) {
          this.onOk(probe);
          return null;
        }
        this.onFail(err, probe);
        // A probe failing means "the primary is still down", not "this call
        // failed": serve it from the fallback instead. `pickServer` re-armed
        // the probe clock when it chose the primary, so the retry lands on the
        // fallback and cannot loop back here.
        if (!probe || !this.fallbackClient) throw err;
      }
    }
  }

  /** Newest payment paging-token for an account, used to seed a fresh watch. */
  async latestCursor(account: string): Promise<string | null> {
    const page = await this.read((client) =>
      client.payments().forAccount(account).order("desc").limit(1).call(),
    );
    const rec = page?.records[0];
    return rec ? rec.paging_token : null; // no page = account not yet created on-chain
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
    const page = await this.read((client) => {
      let builder = client
        .payments()
        .forAccount(account)
        .order("asc")
        .limit(limit)
        .join("transactions");
      if (cursor) builder = builder.cursor(cursor);
      return builder.call();
    });
    if (page === null) return [];

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
