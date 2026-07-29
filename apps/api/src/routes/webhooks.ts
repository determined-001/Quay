import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { registerWebhookSchema } from "@checkout/core";
import type { Container } from "../services/container";
import type { AuthVariables } from "../middleware/auth";

export function webhookRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Register a webhook. The secret is returned ONCE — store it to verify signatures.
  // Authenticated and scoped to the caller (issue 6.4).
  app.post("/", c.auth.requireAuth, async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      body = {};
    }
    const parsed = registerWebhookSchema.safeParse(body);
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const secret = randomBytes(24).toString("hex");
    const hook = await c.webhooks.create({ sellerId: ctx.get("sellerId"), url: parsed.data.url, secret });
    return ctx.json({ id: hook.id, url: hook.url, secret }, 201);
  });

  // List registered webhooks (secrets are not returned). Scoped to the caller.
  app.get("/", c.auth.requireAuth, async (ctx) => {
    const hooks = await c.webhooks.listBySeller(ctx.get("sellerId"));
    return ctx.json({
      webhooks: hooks.map((h) => ({ id: h.id, url: h.url, createdAt: h.createdAt })),
    });
  });

  return app;
}
