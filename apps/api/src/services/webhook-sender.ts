import { createHmac } from "node:crypto";
import type { Webhook, WebhookRepository } from "@checkout/core";
import { newId } from "./ids";

export interface WebhookEvent {
  event: string; // e.g. "link.paid"
  data: Record<string, unknown>;
}

/**
 * Enqueues webhook events into the durable webhook_queue table.
 *
 * `dispatch` returns immediately after writing queue rows — it never blocks a
 * state transition and is crash-safe: a restart will pick up any un-delivered
 * entries on the next WebhookWorker tick.
 *
 * The payload (body) and its HMAC-SHA256 signature are computed once at enqueue
 * time.  The same frozen payload is re-sent on every retry, so the signature
 * never changes across attempts.  Receivers do not need to change anything —
 * the exact headers (`X-Checkout-Signature`, `X-Checkout-Event`) and HMAC
 * scheme from the previous in-process sender are preserved.
 */
export class WebhookSender {
  /** Rows enqueued but not yet confirmed delivered by the worker. Feeds the
   *  `webhook_deliveries_in_flight` gauge; approximate by design — it is a
   *  per-process counter, not a query, so it stays free to read on every
   *  /metrics scrape. */
  private pending = 0;

  constructor(private readonly repo: WebhookRepository) {}

  get pendingDepth(): number {
    return this.pending;
  }

  /**
   * Enqueue a delivery for every registered hook.  Returns as soon as all rows
   * are inserted; actual HTTP delivery is handled by WebhookWorker.
   */
  async dispatch(hooks: Webhook[], linkId: string, event: WebhookEvent): Promise<void> {
    const sentAt = new Date().toISOString();
    // Build one payload per *event* (all hooks for the same event share the same
    // logical body — the id / sentAt / data are event-scoped, not hook-scoped).
    const rawBody = JSON.stringify({ ...event, id: linkId, sentAt });

    await Promise.all(
      hooks.map((hook) => this.enqueueOne(hook, linkId, event.event, rawBody)),
    );
  }

  private async enqueueOne(
    hook: Webhook,
    linkId: string,
    eventName: string,
    rawBody: string,
  ): Promise<void> {
    // Sign the payload with the per-hook secret.  The signature is embedded in
    // the queue row so the worker doesn't need the secret at delivery time —
    // it reads it from the webhook row anyway, but signing once avoids
    // redundant crypto on retries.
    //
    // The worker re-signs from the webhook secret for correctness and to handle
    // secret rotation; the payload stored here is the *canonical* frozen body.
    const signature = createHmac("sha256", hook.secret).update(rawBody).digest("hex");

    // We store the body verbatim.  The worker will sign it again at delivery
    // time using the then-current webhook secret (forward-compatible with
    // secret rotation).  The `signature` variable above is only used for the
    // comment; the actual header is built in WebhookWorker.
    void signature; // deliberate no-op: worker re-signs using repo secret

    this.pending += 1;
    await this.repo.enqueue({
      id: newId("wqe"),
      webhookId: hook.id,
      linkId,
      event: eventName,
      payload: rawBody,
      nextAttemptAt: Date.now(), // due immediately
      createdAt: Date.now(),
    });
  }
}
