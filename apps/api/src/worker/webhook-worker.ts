import { createHmac } from "node:crypto";
import type { Webhook, WebhookQueueEntry, WebhookRepository } from "@checkout/core";
import { newId } from "../services/ids";

export interface WebhookWorkerOptions {
  /**
   * Maximum delivery attempts before a queue entry is dead-lettered (default 5).
   * Attempt counts include the initial attempt, so 5 means 1 try + 4 retries.
   */
  maxAttempts?: number;
  /**
   * Base backoff in ms for exponential reschedule: delay = baseDelayMs * 2^(attempt-1)
   * with full jitter applied (default 5_000 ms → intervals ≈ 5 s, 10 s, 20 s, 40 s).
   */
  baseDelayMs?: number;
  /** Per-request HTTP timeout in ms (default 8_000). */
  timeoutMs?: number;
  /** How often the worker polls the queue (default 3_000 ms). */
  pollIntervalMs?: number;
  /** Max rows claimed per tick (default 20). */
  batchSize?: number;
  log?: (msg: string) => void;
}

/**
 * Durable webhook delivery worker.
 *
 * On each tick the worker:
 *   1. Claims up to `batchSize` pending queue entries whose next_attempt_at <= now.
 *   2. For each entry, fetches the registered webhook (for its URL + secret), builds
 *      the signed request, and delivers.
 *   3. On success   → status = 'delivered', records a WebhookDelivery row.
 *   4. On transient failure (network, 5xx, 429)
 *        → attempts < maxAttempts: status = 'pending', next_attempt_at bumped with backoff.
 *        → attempts >= maxAttempts: status = 'dead' (dead-letter).
 *   5. On permanent failure (4xx except 429)
 *        → immediately dead-letters without further retries.
 *
 * The signing scheme is identical to the old WebhookSender:
 *   X-Checkout-Signature: sha256=<hmac-hex>
 * The payload is frozen at enqueue time so the signature never changes across retries —
 * receivers see the same body/signature regardless of which attempt delivered it.
 */
export class WebhookWorker {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly log: (msg: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repo: WebhookRepository,
    opts: WebhookWorkerOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    this.baseDelayMs = opts.baseDelayMs ?? 5_000;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3_000;
    this.batchSize = opts.batchSize ?? 20;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (err) {
        this.log(`webhook worker tick error: ${errMsg(err)}`);
      } finally {
        if (this.running) this.timer = setTimeout(tick, this.pollIntervalMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing: run one full claim → deliver → update cycle. */
  async runOnce(): Promise<void> {
    const entries = await this.repo.claimDue(Date.now(), this.batchSize);
    if (entries.length === 0) return;

    // Resolve webhooks for all unique webhook IDs in this batch.
    const webhookIds = [...new Set(entries.map((e) => e.webhookId))];
    const hookMap = await this.resolveWebhooks(webhookIds);

    await Promise.all(entries.map((entry) => this.processEntry(entry, hookMap)));
  }

  private async processEntry(
    entry: WebhookQueueEntry,
    hookMap: Map<string, Webhook>,
  ): Promise<void> {
    const hook = hookMap.get(entry.webhookId);
    if (!hook) {
      // Webhook was deleted after enqueue — dead-letter immediately.
      this.log(`queue ${short(entry.id)}: webhook ${short(entry.webhookId)} not found, dead-lettering`);
      await this.repo.updateQueueEntry(entry.id, {
        status: "dead",
        attempts: entry.attempts + 1,
        nextAttemptAt: entry.nextAttemptAt,
        lastStatusCode: null,
        lastError: "webhook not found",
      });
      await this.recordAttempt(entry, entry.attempts + 1, null, false, "webhook not found");
      return;
    }

    const attemptNumber = entry.attempts + 1;
    let statusCode: number | null = null;
    let error: string | null = null;
    let ok = false;

    try {
      const signature = createHmac("sha256", hook.secret).update(entry.payload).digest("hex");
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-checkout-signature": `sha256=${signature}`,
          "x-checkout-event": entry.event,
        },
        body: entry.payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      statusCode = res.status;

      if (res.ok) {
        ok = true;
      } else if (res.status < 500 && res.status !== 429) {
        // Permanent failure: 4xx (not 429) — dead-letter immediately.
        error = `HTTP ${res.status}`;
        await this.finalise(entry, attemptNumber, statusCode, false, error, "dead");
        return;
      } else {
        error = `HTTP ${res.status}`;
      }
    } catch (err) {
      error = errMsg(err);
    }

    if (ok) {
      await this.finalise(entry, attemptNumber, statusCode, true, null, "delivered");
    } else if (attemptNumber >= this.maxAttempts) {
      // Exhausted all attempts.
      await this.finalise(entry, attemptNumber, statusCode, false, error, "dead");
    } else {
      // Reschedule with exponential backoff + full jitter.
      const delay = this.backoff(attemptNumber);
      const nextAttemptAt = Date.now() + delay;
      this.log(
        `queue ${short(entry.id)} attempt ${attemptNumber} failed (${error ?? "unknown"}), ` +
          `retry in ${Math.round(delay / 1000)}s`,
      );
      await this.repo.updateQueueEntry(entry.id, {
        status: "pending",
        attempts: attemptNumber,
        nextAttemptAt,
        lastStatusCode: statusCode,
        lastError: error,
      });
      await this.recordAttempt(entry, attemptNumber, statusCode, false, error);
    }
  }

  private async finalise(
    entry: WebhookQueueEntry,
    attemptNumber: number,
    statusCode: number | null,
    ok: boolean,
    error: string | null,
    status: "delivered" | "dead",
  ): Promise<void> {
    const label = status === "delivered" ? "✓ delivered" : "✗ dead-lettered";
    this.log(
      `queue ${short(entry.id)} attempt ${attemptNumber} ${label}` +
        (statusCode !== null ? ` (HTTP ${statusCode})` : "") +
        (error ? ` — ${error}` : ""),
    );
    await this.repo.updateQueueEntry(entry.id, {
      status,
      attempts: attemptNumber,
      nextAttemptAt: entry.nextAttemptAt,
      lastStatusCode: statusCode,
      lastError: error,
    });
    await this.recordAttempt(entry, attemptNumber, statusCode, ok, error);
  }

  private async recordAttempt(
    entry: WebhookQueueEntry,
    attemptNumber: number,
    statusCode: number | null,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    await this.repo.recordDelivery({
      webhookId: entry.webhookId,
      linkId: entry.linkId,
      event: entry.event,
      attempt: attemptNumber,
      queueEntryId: entry.id,
      statusCode,
      ok,
      error,
    });
  }

  /**
   * Resolve Webhook objects for a set of webhook IDs.
   * Runs all lookups in parallel since the batch is small.
   */
  private async resolveWebhooks(ids: string[]): Promise<Map<string, Webhook>> {
    const map = new Map<string, Webhook>();
    await Promise.all(
      ids.map(async (id) => {
        const hook = await this.repo.findWebhookById(id);
        if (hook) map.set(id, hook);
      }),
    );
    return map;
  }

  /** Exponential backoff with full jitter: random in [0, baseDelayMs * 2^(attempt-1)]. */
  private backoff(attempt: number): number {
    const ceiling = this.baseDelayMs * Math.pow(2, attempt - 1);
    return Math.floor(Math.random() * ceiling);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function short(s: string): string {
  return s.length > 16 ? `${s.slice(0, 8)}…` : s;
}
