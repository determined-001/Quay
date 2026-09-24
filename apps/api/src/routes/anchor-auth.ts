import { Hono } from "hono";
import { z } from "zod";
import { AnchorChallengeError } from "@checkout/offramp";
import type { Container } from "../services/container";
import { customerOf } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";

const completeSchema = z.object({ transaction: z.string().min(1) });

/**
 * The seller's own SEP-10 session with the anchor.
 *
 * The anchor's challenge is fetched and verified here, signed by the seller's
 * wallet in the browser, and posted back. Quay never signs it: the anchor's
 * customer is the seller's account, not the platform's, so each seller's KYC
 * and withdrawals are theirs alone.
 *
 * Gated by `offramp:initiate` for the same reason as /seller/kyc: this session
 * exists only to cash out, so the scope that moves money governs it.
 */
export function anchorAuthRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(
    "*",
    buildAuthMiddleware({
      session: c.auth.session,
      sellers: c.sellers,
      revocations: c.auth.revocations,
      apiKeyRepo: c.apiKeys,
      allowedOrigins: c.auth.allowedOrigins,
    }),
    requireScope("offramp:initiate"),
  );

  // Whether the seller has a live session. `required: false` means this
  // deployment has no real anchor (mock / none), so there is nothing to do.
  app.get("/", async (ctx) => {
    const auth = c.anchorAuth;
    if (!auth) return ctx.json({ required: false, connected: false, anchor: null, expiresAt: null });
    const expiresAt = await auth.sessionExpiry(customerOf(ctx.get("seller")));
    return ctx.json({ required: true, connected: expiresAt !== null, anchor: auth.anchorDomain, expiresAt });
  });

  // A verified challenge for the seller's wallet to sign.
  app.post("/challenge", async (ctx) => {
    const auth = c.anchorAuth;
    if (!auth) return ctx.json({ error: "no_anchor" }, 404);
    try {
      return ctx.json(await auth.challenge(customerOf(ctx.get("seller"))));
    } catch (err) {
      if (err instanceof AnchorChallengeError) return ctx.json({ error: "challenge_rejected", message: err.message }, 502);
      throw err;
    }
  });

  // Relay the signed challenge; the anchor's JWT is kept, never returned.
  app.post("/", async (ctx) => {
    const auth = c.anchorAuth;
    if (!auth) return ctx.json({ error: "no_anchor" }, 404);
    const parsed = completeSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const { expiresAt } = await auth.complete(customerOf(ctx.get("seller")), parsed.data.transaction);
      return ctx.json({ connected: true, anchor: auth.anchorDomain, expiresAt });
    } catch (err) {
      if (err instanceof AnchorChallengeError) return ctx.json({ error: "challenge_rejected", message: err.message }, 400);
      throw err;
    }
  });

  app.delete("/", async (ctx) => {
    await c.anchorAuth?.signOut(ctx.get("seller").id);
    return ctx.body(null, 204);
  });

  return app;
}
