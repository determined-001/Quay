import { createHmac } from "node:crypto";
import type { Webhook, WebhookRepository } from "@checkout/core";

export interface WebhookEvent {
  event: string; // e.g. "link.paid"
  data: Record<string, unknown>;
}

/**
 * Delivers events to a seller's registered webhooks. The body is signed with
 * HMAC-SHA256 using the per-webhook secret, sent as `X-Checkout-Signature`.
 * Receivers verify by recomputing the HMAC over the exact raw body.
 */
export class WebhookSender {
  constructor(private readonly repo: WebhookRepository) {}

  async dispatch(hooks: Webhook[], linkId: string, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify({ ...event, id: linkId, sentAt: new Date().toISOString() });

    await Promise.all(
      hooks.map(async (hook) => {
        const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-checkout-signature": `sha256=${signature}`,
              "x-checkout-event": event.event,
            },
            body,
            signal: AbortSignal.timeout(8000),
          });
          await this.repo.recordDelivery({
            webhookId: hook.id,
            linkId,
            event: event.event,
            statusCode: res.status,
            ok: res.ok,
            error: res.ok ? null : `HTTP ${res.status}`,
          });
        } catch (err) {
          await this.repo.recordDelivery({
            webhookId: hook.id,
            linkId,
            event: event.event,
            statusCode: null,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }
}
