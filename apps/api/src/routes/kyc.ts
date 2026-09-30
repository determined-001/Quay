import { Hono } from "hono";
import { z } from "zod";
import { AnchorAuthRequiredError, KycRequiredError, type KycRecord } from "@checkout/core";
// The SEP-9 allowlist lives in @checkout/offramp next to the SEP-24 client that
// enforces it, so the UI can only ever offer names that path would send.
import { isPrefillField, prefillableFieldNames } from "@checkout/offramp";
import type { Container } from "../services/container";
import { customerOf } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";

const submitKycSchema = z.record(z.string(), z.string());

/**
 * Body of PUT /seller/kyc/prefill-consent. A plain string array, deliberately
 * not a record: this endpoint records NAMES, and accepting a record would let a
 * caller post values that then sit in the consent table looking like something
 * they are not. Empty is legal and means "revoke everything for this anchor" —
 * narrowing consent must not need a separate DELETE round trip.
 */
const prefillConsentSchema = z.object({
  fields: z.array(z.string()).max(64),
});

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
      allowedOrigins: c.auth.allowedOrigins,
    }),
    requireScope("offramp:initiate"),
  );

  // Current requirements + status, re-synced from the anchor.
  app.get("/", async (ctx) => {
    try {
      const record = await c.kyc.status(customerOf(ctx.get("seller")));
      return ctx.json(toResponse(record));
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
      throw err;
    }
  });

  // Submit or update identity fields. Never accepts a partial submission
  // silently — a known-missing required field is a 422, naming exactly
  // which fields are missing, not a fabricated default.
  app.put("/", async (ctx) => {
    const parsed = submitKycSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    try {
      const record = await c.kyc.submit(customerOf(ctx.get("seller")), parsed.data);
      return ctx.json(toResponse(record));
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
      if (err instanceof KycRequiredError) {
        return ctx.json({ error: "kyc_required", missingFields: err.missingFields }, 422);
      }
      throw err;
    }
  });

  // ─── SEP-24 prefill consent (issue 3.17) ───────────────────────────────────
  //
  // Which SEP-9 field NAMES this seller agreed to share with THIS anchor, so
  // the anchor can pre-fill its own hosted form on a SEP-24 interactive
  // withdraw. Mounted here rather than under /seller/anchor-auth because it is
  // a property of the seller's KYC profile and its scope (`offramp:initiate`) is
  // the same: this identity exists to satisfy an anchor before a cash-out.
  //
  // No values pass through either route. `available` is allowlisted field names
  // we hold a value for — the checklist the dashboard renders — and `fields` is
  // the seller's current grant, also names only. Reading the profile here (rather
  // than via `c.kyc.status`) is deliberate: managing consent must not require a
  // live anchor session, because a seller may well want to revoke before
  // signing in to anything.
  app.get("/prefill-consent", async (ctx) => {
    const anchorDomain = c.anchorDomain;
    if (!anchorDomain) return ctx.json({ error: "no_anchor" }, 404);

    const seller = ctx.get("seller");
    const consent = c.prefillConsent
      ? await c.prefillConsent.get(seller.id, anchorDomain)
      : null;
    const record = c.kycRepo ? await c.kycRepo.get(seller.id) : null;

    return ctx.json({
      anchorDomain,
      fields: consent?.fields ?? [],
      grantedAt: consent?.grantedAt ?? null,
      // Allowlisted names we actually hold a value for, so the UI can only ever
      // offer something the prefill path would send.
      available: record ? prefillableFieldNames(record.providedFields) : [],
    });
  });

  app.put("/prefill-consent", async (ctx) => {
    const anchorDomain = c.anchorDomain;
    if (!anchorDomain) return ctx.json({ error: "no_anchor" }, 404);
    if (!c.prefillConsent) return ctx.json({ error: "no_anchor" }, 404);

    const parsed = prefillConsentSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    // Consent can only ever narrow what is sent, so an unknown or
    // not-allowlisted name is refused loudly rather than quietly stored and
    // filtered later — a caller that thinks it consented to something should
    // not get a 200 back implying it did.
    const unknown = parsed.data.fields.filter((name) => !isPrefillField(name));
    if (unknown.length > 0) {
      return ctx.json({ error: "unknown_fields", fields: unknown }, 400);
    }

    const seller = ctx.get("seller");
    const fields = [...new Set(parsed.data.fields)].sort();
    if (fields.length === 0) {
      await c.prefillConsent.delete(seller.id, anchorDomain);
      return ctx.json({ anchorDomain, fields: [], grantedAt: null });
    }

    const grantedAt = Date.now();
    await c.prefillConsent.save({ sellerId: seller.id, anchorDomain, fields, grantedAt });
    return ctx.json({ anchorDomain, fields, grantedAt });
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
