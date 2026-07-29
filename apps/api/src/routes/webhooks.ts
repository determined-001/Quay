import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { registerWebhookSchema } from "@checkout/core";
import type { Container } from "../services/container";

export function webhookRoutes(c: Container): Hono {
  const app = new Hono();

  // Register a webhook. The secret is returned ONCE — store it to verify signatures.
  app.post("/", async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      body = {};
    }
    const parsed = registerWebhookSchema.safeParse(body);
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const seller = await c.sellers.getDefault();
    const secret = randomBytes(24).toString("hex");
    const hook = await c.webhooks.create({ sellerId: seller.id, url: parsed.data.url, secret });
    return ctx.json({ id: hook.id, url: hook.url, secret }, 201);
  });

  // List registered webhooks (secrets are not returned).
  app.get("/", async (ctx) => {
    const seller = await c.sellers.getDefault();
    const hooks = await c.webhooks.listBySeller(seller.id);
    return ctx.json({
      webhooks: hooks.map((h) => ({ id: h.id, url: h.url, createdAt: h.createdAt })),
    });
  });

  /**
   * POST /webhooks/deliveries/:id/replay
   *
   * Re-enqueues a dead-lettered (or any) queue entry for immediate redelivery.
   * Returns 202 Accepted with the updated entry summary. The actual delivery
   * happens on the next WebhookWorker tick (within seconds).
   *
   * Idempotent if called on an entry that is already pending or delivered:
   *   - pending   → next_attempt_at reset to now (no-op on next tick if already 0)
   *   - delivered → re-queued as pending (manual replay of a successful delivery)
   *   - dead      → re-queued as pending (the primary use-case)
   *   - claimed   → 409 (delivery is in-flight; wait for it to settle first)
   */
  app.post("/deliveries/:id/replay", async (ctx) => {
    const id = ctx.req.param("id");
    const entry = await c.webhooks.findQueueEntry(id);

    if (!entry) {
      return ctx.json({ error: "not_found", message: `No delivery queue entry with id "${id}"` }, 404);
    }

    if (entry.status === "claimed") {
      return ctx.json(
        { error: "in_flight", message: "Delivery is currently in-flight; wait for it to settle before replaying." },
        409,
      );
    }

    await c.webhooks.updateQueueEntry(id, {
      status: "pending",
      attempts: entry.attempts, // preserve history count; worker increments on next attempt
      nextAttemptAt: Date.now(),
      lastStatusCode: entry.lastStatusCode,
      lastError: entry.lastError,
    });

    return ctx.json(
      {
        id: entry.id,
        webhookId: entry.webhookId,
        linkId: entry.linkId,
        event: entry.event,
        previousAttempts: entry.attempts,
        status: "pending",
        message: "Queued for immediate redelivery.",
      },
      202,
    );
  });

  return app;
}
