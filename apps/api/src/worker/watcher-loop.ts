import {
  matchPayment,
  type LinkRepository,
  type PaymentLink,
  type WatcherPort,
  type WatcherStateRepository,
} from "@checkout/core";
import type { LinkService } from "../services/link-service";

/** Horizon's own page size default (see `HorizonWatcher.fetchSince`) - kept in sync explicitly rather than duplicated as a bare number in two files. */
const DEFAULT_PAGE_LIMIT = 200;

/** Hard cap on pages drained per account per tick (issue 2.2) - bounds one tick's worst-case latency instead of looping until the backlog is empty, which could starve other accounts' ticks. Hitting this repeatedly is the signal to move to a streaming watcher (issue 2.1), not to raise this number further. */
const DEFAULT_MAX_PAGES_PER_TICK = 10;

/**
 * Polling settlement watcher.
 *
 * Each tick, for every account that has open links, we pull payments after the
 * stored cursor and match them to links by memo. Idempotency is layered:
 *   1. the persisted cursor means we don't refetch already-seen operations;
 *   2. the processed-tx ledger guards the crash window before a cursor is saved;
 *   3. the domain transition guard means a duplicate can never double-apply.
 *
 * A single Horizon page is bounded by `pageLimit` (default 200, matching
 * `HorizonWatcher.fetchSince`'s own default). If more than `pageLimit`
 * payments landed since the last tick, `processAccount` keeps paging - up to
 * `maxPagesPerTick` pages - within the *same* tick, persisting the cursor
 * after every page (not once at the end), so a crash mid-drain resumes from
 * the last completed page rather than replaying the whole backlog.
 */
export class WatcherLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pageLimit: number;
  private readonly maxPagesPerTick: number;

  constructor(
    private readonly deps: {
      watcher: WatcherPort;
      links: LinkRepository;
      state: WatcherStateRepository;
      service: LinkService;
      pollMs: number;
      pageLimit?: number;
      maxPagesPerTick?: number;
      log?: (msg: string) => void;
    },
  ) {
    this.pageLimit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.maxPagesPerTick = deps.maxPagesPerTick ?? DEFAULT_MAX_PAGES_PER_TICK;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.deps.log?.(`watcher tick error: ${stringifyErr(err)}`);
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.deps.pollMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    const accounts = await this.deps.links.activeDestinations();
    for (const account of accounts) {
      try {
        await this.processAccount(account);
      } catch (err) {
        this.deps.log?.(`watcher account ${short(account)} error: ${stringifyErr(err)}`);
      }
    }
  }

  private async processAccount(account: string): Promise<void> {
    const cursor = await this.deps.state.getCursor(account);

    // First time we watch this account: seed the cursor to "now" so we only
    // react to payments that arrive after watching begins (no history replay).
    if (cursor === null) {
      const latest = await this.deps.watcher.latestCursor(account);
      await this.deps.state.setCursor(account, latest ?? "");
      return;
    }

    // Fetched once per account per tick, not once per page - the set of open
    // links doesn't change mid-drain (a payment landing this tick can't also
    // close a link before we've matched it), so re-fetching per page would
    // just be wasted I/O.
    const open = await this.deps.links.openLinksForDestination(account);
    const byRef = new Map<string, PaymentLink>(open.map((l) => [l.reference, l]));

    let pageCursor = cursor;

    for (let page = 1; page <= this.maxPagesPerTick; page++) {
      const payments = await this.deps.watcher.fetchSince(account, pageCursor, this.pageLimit);
      if (payments.length === 0) break;

      let lastToken = pageCursor;
      for (const payment of payments) {
        lastToken = payment.pagingToken;
        if (await this.deps.state.isProcessed(payment.txHash)) continue;

        const outcome = matchPayment(payment, (ref) => byRef.get(ref));
        const linkId =
          outcome.kind === "paid" || outcome.kind === "underpaid" || outcome.kind === "asset_mismatch"
            ? outcome.link.id
            : null;

        if (outcome.kind === "paid" || outcome.kind === "underpaid") {
          const becamePaid = await this.deps.service.applyMatch(payment, outcome);
          this.deps.log?.(
            `payment ${short(payment.txHash)} -> ${outcome.kind}` +
              (becamePaid ? ` (link ${linkId} PAID)` : ""),
          );
        }

        await this.deps.state.markProcessed(payment.txHash, linkId);
      }

      pageCursor = lastToken;
      // Persisted after *every* page, not once at the end of the whole
      // drain - a crash between pages resumes from the last completed page
      // instead of replaying the entire backlog from the tick's start.
      await this.deps.state.setCursor(account, pageCursor);

      if (payments.length < this.pageLimit) {
        // Short page: caught up for this tick.
        return;
      }

      if (page === this.maxPagesPerTick) {
        this.deps.log?.(
          `watcher account ${short(account)} hit maxPagesPerTick (${this.maxPagesPerTick}) - ` +
            `backlog not fully drained this tick, more remains for the next poll. ` +
            `If this recurs, move this account to a streaming watcher (issue 2.1).`,
        );
      }
    }
  }
}

/** Periodically advance any pending seller cash-outs. */
export function startCashOutPoller(service: LinkService, intervalMs: number): () => void {
  const timer = setInterval(() => {
    void service.pollCashOuts().catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
