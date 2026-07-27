import {
  matchPayment,
  type LinkRepository,
  type Logger,
  type PaymentLink,
  type WatcherPort,
  type WatcherStateRepository,
  NOOP_LOGGER,
} from "@checkout/core";
import type { LinkService } from "../services/link-service";

/**
 * Polling settlement watcher.
 *
 * Each tick, for every account that has open links, we pull payments after the
 * stored cursor and match them to links by memo. Idempotency is layered:
 *   1. the persisted cursor means we don't refetch already-seen operations;
 *   2. the processed-tx ledger guards the crash window before a cursor is saved;
 *   3. the domain transition guard means a duplicate can never double-apply.
 */
export class WatcherLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      watcher: WatcherPort;
      links: LinkRepository;
      state: WatcherStateRepository;
      service: LinkService;
      pollMs: number;
      logger?: Logger;
    },
  ) {
    this.deps.logger = this.deps.logger ?? NOOP_LOGGER;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      const tickLogger = this.deps.logger!.child({ tick: Date.now(), component: "watcher" });
      try {
        await this.runOnce(tickLogger);
      } catch (err) {
        tickLogger.error({ event: "watcher.tick.error", error: stringifyErr(err) }, "watcher tick error");
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

  async runOnce(parentLogger?: Logger): Promise<void> {
    const log = parentLogger ?? this.deps.logger!;
    const accounts = await this.deps.links.activeDestinations();
    if (accounts.length === 0) return;
    for (const account of accounts) {
      try {
        await this.processAccount(account, log.child({ destination: account }));
      } catch (err) {
        log.error({ event: "watcher.account.error", destination: account, error: stringifyErr(err) }, "watcher account error");
      }
    }
  }

  private async processAccount(account: string, log: Logger): Promise<void> {
    const cursor = await this.deps.state.getCursor(account);

    // First time we watch this account: seed the cursor to "now" so we only
    // react to payments that arrive after watching begins (no history replay).
    if (cursor === null) {
      const latest = await this.deps.watcher.latestCursor(account);
      await this.deps.state.setCursor(account, latest ?? "");
      log.info(
        { event: "watcher.account.seeded", fromCursor: null, toCursor: latest },
        "watcher account seeded",
      );
      return;
    }

    const payments = await this.deps.watcher.fetchSince(account, cursor);
    if (payments.length === 0) {
      log.debug({ event: "watcher.account.idle", cursor }, "no new payments");
      return;
    }
    log.info({ event: "watcher.account.batch", cursor, count: payments.length }, "fetched payments");

    const open = await this.deps.links.openLinksForDestination(account);
    const byRef = new Map<string, PaymentLink>(open.map((l) => [l.reference, l]));

    let lastToken = cursor;
    for (const payment of payments) {
      lastToken = payment.pagingToken;
      const child = log.child({ txHash: payment.txHash, pagingToken: payment.pagingToken });
      if (await this.deps.state.isProcessed(payment.txHash)) {
        child.info({ event: "payment.duplicate" }, "skipping already-processed payment");
        continue;
      }

      const outcome = matchPayment(payment, (ref) => byRef.get(ref));
      const linkId =
        outcome.kind === "paid" || outcome.kind === "underpaid" || outcome.kind === "asset_mismatch"
          ? outcome.link.id
          : null;
      child.info(
        { event: "payment.matched", outcome: outcome.kind, linkId, amount: payment.amount, memo: payment.memo },
        `payment ${outcome.kind}`,
      );

      if (outcome.kind === "paid" || outcome.kind === "underpaid") {
        // applyMatch will emit its own link.transition line if it commits.
        // Pass the per-payment child so requestId (if any) flows with it.
        await this.deps.service.applyMatch(payment, outcome, { logger: child });
      }

      await this.deps.state.markProcessed(payment.txHash, linkId);
    }

    await this.deps.state.setCursor(account, lastToken);
  }
}

/** Periodically advance any pending seller cash-outs. */
export function startCashOutPoller(service: LinkService, intervalMs: number, logger?: Logger): () => void {
  const log = logger ?? NOOP_LOGGER;
  const pollerLogger = log.child({ component: "cashout-poller" });
  const timer = setInterval(() => {
    void service.pollCashOuts().catch((err) => {
      pollerLogger.error({ event: "cashout.tick.error", error: stringifyErr(err) }, "cash-out tick error");
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
