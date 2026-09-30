import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { AnchorChallengeError, AnchorHttpError, type AnchorChallengeErrorKind } from "@checkout/offramp";
import { anchorFailure } from "../services/link-service";
import { getLogger } from "../request-context";
import type { Container } from "../services/container";
import { customerOf } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";

/**
 * Fixed text per failure kind. `AnchorChallengeError.message` can carry the
 * anchor's own wording, so it is logged and never returned (issue 4.36).
 */
const CHALLENGE_MESSAGES: Record<AnchorChallengeErrorKind, string> = {
  wrong_network: "The anchor's challenge was built for a different Stellar network.",
  wrong_account: "The challenge or token belongs to a different account than your signed-in wallet.",
  refused: "The anchor refused the signed challenge.",
  unverifiable: "This anchor could not be verified, so no challenge was issued.",
  invalid: "The anchor's challenge could not be verified.",
};

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
export function anchorAuthRoutes(c: Container, anchorAuthLimit: MiddlewareHandler): Hono<{ Variables: AuthVariables }> {
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

  // The limiter is attached per POST route below, after the auth middleware
  // above has populated the seller used by its per-seller key.
  // A verified challenge for the seller's wallet to sign.
  app.post("/challenge", anchorAuthLimit, async (ctx) => {
    const auth = c.anchorAuth;
    if (!auth) return ctx.json({ error: "no_anchor" }, 404);
    try {
      return ctx.json(await auth.challenge(customerOf(ctx.get("seller"))));
    } catch (err) {
      if (err instanceof AnchorChallengeError) {
        getLogger(ctx).warn({ event: "anchor.challenge.rejected", kind: err.kind, reason: err.message }, "challenge rejected");
        return ctx.json({ error: "challenge_rejected", message: CHALLENGE_MESSAGES[err.kind] }, 502);
      }
      if (err instanceof AnchorHttpError) {
        const failure = anchorFailure(err, getLogger(ctx));
        return ctx.json({ error: failure.message, ...failure.extra }, 502);
      }
      throw err;
    }
  });

  // Relay the signed challenge; the anchor's JWT is kept, never returned.
  app.post("/", anchorAuthLimit, async (ctx) => {
    const auth = c.anchorAuth;
    if (!auth) return ctx.json({ error: "no_anchor" }, 404);
    const parsed = completeSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const { expiresAt } = await auth.complete(customerOf(ctx.get("seller")), parsed.data.transaction);
      return ctx.json({ connected: true, anchor: auth.anchorDomain, expiresAt });
    } catch (err) {
      if (err instanceof AnchorChallengeError) {
        getLogger(ctx).warn({ event: "anchor.challenge.rejected", kind: err.kind, reason: err.message }, "challenge rejected");
        return ctx.json({ error: "challenge_rejected", message: CHALLENGE_MESSAGES[err.kind] }, 400);
      }
      if (err instanceof AnchorHttpError) {
        const failure = anchorFailure(err, getLogger(ctx));
        return ctx.json({ error: failure.message, ...failure.extra }, 502);
      }
      throw err;
    }
  });

  app.delete("/", async (ctx) => {
    await c.anchorAuth?.signOut(ctx.get("seller").id);
    return ctx.body(null, 204);
  });

  return app;
}
