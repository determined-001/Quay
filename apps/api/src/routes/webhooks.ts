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

  return app;
}
