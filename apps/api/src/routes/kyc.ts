import { Hono } from "hono";
import { z } from "zod";
import { KycRequiredError, type KycRecord } from "@checkout/core";
import type { Container } from "../services/container";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";

const submitKycSchema = z.record(z.string(), z.string());

function toResponse(record: KycRecord) {
  return {
    status: record.status,
    requiredFields: record.requiredFields,
    providedFields: record.providedFields,
    message: record.message,
    lastSyncedAt: record.lastSyncedAt,
  };
}

/**
 * Seller SEP-12 identity.
 *
 * Both routes are authenticated and scoped. They were previously mounted with
 * no auth middleware at all and resolved the seller with `sellers.getDefault()`,
 * which meant that on the production configuration (`OFFRAMP=testanchor`, where
 * `TestAnchorKyc` is live):
 *
 *   - `GET /seller/kyc` returned `providedFields` — the seller's SEP-12 identity
 *     values, decrypted out of the database by `DrizzleKycRepository` — to any
 *     unauthenticated caller. The AES-256-GCM at-rest encryption in
 *     `crypto/pii.ts` protects exactly this data, and this route handed over the
 *     plaintext.
 *   - `PUT /seller/kyc` let any unauthenticated caller overwrite that identity
 *     and submit it to the live anchor via `putSep12Customer`.
 *
 * `offramp:initiate` is the gating scope rather than a new KYC-specific one:
 * this identity exists solely to satisfy the anchor before a cash-out, so the
 * scope that authorizes moving money is the one that should authorize managing
 * the identity used to move it. Sessions carry ALL_SCOPES, so the dashboard is
 * unaffected.
 */
export function kycRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(
    "*",
    buildAuthMiddleware({
      session: c.auth.session,
      sellers: c.sellers,
      revocations: c.auth.revocations,
      apiKeyRepo: c.apiKeys,
    }),
    requireScope("offramp:initiate"),
  );

  // Current requirements + status, re-synced from the anchor.
  app.get("/", async (ctx) => {
    const record = await c.kyc.status(ctx.get("seller").id);
    return ctx.json(toResponse(record));
  });

  // Submit or update identity fields. Never accepts a partial submission
  // silently — a known-missing required field is a 422, naming exactly
  // which fields are missing, not a fabricated default.
  app.put("/", async (ctx) => {
    const parsed = submitKycSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    try {
      const record = await c.kyc.submit(ctx.get("seller").id, parsed.data);
      return ctx.json(toResponse(record));
    } catch (err) {
      if (err instanceof KycRequiredError) {
        return ctx.json({ error: "kyc_required", missingFields: err.missingFields }, 422);
      }
      throw err;
    }
  });

  return app;
}

async function safeJson(ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    return {};
  }
}
