import { Hono } from "hono";
import { z } from "zod";
import {
  AnchorAuthRequiredError,
  KycRequiredError,
  ConsentRequiredError,
  type KycRecord,
  type KycConsent,
} from "@checkout/core";
import type { Container } from "../services/container";
import { customerOf } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";

const submitKycSchema = z.record(z.string(), z.string());

const grantConsentSchema = z.object({
  anchorDomain: z.string().min(1),
  fields: z.array(z.string()).min(1),
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

function consentToResponse(consent: KycConsent) {
  return {
    id: consent.id,
    anchorDomain: consent.anchorDomain,
    fields: consent.fields,
    grantedAt: consent.grantedAt,
    revokedAt: consent.revokedAt,
    grantedVia: consent.grantedVia,
    noticeVersion: consent.noticeVersion,
  };
}

/**
 * Seller SEP-12 identity + per-anchor consent.
 *
 * All routes require authentication and the `offramp:initiate` scope.
 * Consent routes (GET/POST/DELETE /consent/*) reject API-key auth — only
 * session-authenticated sellers can grant or revoke consent.
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

  // Consent routes — session auth only (reject API keys)
  const consentApp = new Hono<{ Variables: AuthVariables }>();

  consentApp.use("*", async (ctx, next) => {
    const authKind = ctx.get("authKind");
    if (authKind === "api_key") {
      return ctx.json({ error: "forbidden", message: "consent endpoints require session authentication" }, 403);
    }
    await next();
  });

  // GET /seller/kyc/consent — list active and past consents for the seller
  consentApp.get("/", async (ctx) => {
    const seller = ctx.get("seller");
    const consents = await c.kycConsents.list(seller.id);
    return ctx.json({ consents: consents.map(consentToResponse) });
  });

  // POST /seller/kyc/consent — grant consent for specific fields with an anchor
  consentApp.post("/", async (ctx) => {
    const seller = ctx.get("seller");
    const parsed = grantConsentSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const { anchorDomain, fields } = parsed.data;

    // Re-derive the fields the anchor currently requests from the latest KYC record
    // to ensure the UI cannot consent to fields the anchor did not ask for.
    try {
      const record = await c.kyc.status(customerOf(seller));
      const anchorRequiredFields = record.requiredFields.map((f) => f.name);

      // Check that every field in the request is among the anchor's currently required fields
      const extraFields = fields.filter((f) => !anchorRequiredFields.includes(f));
      if (extraFields.length > 0) {
        return ctx.json(
          {
            error: "invalid_fields",
            message: "Consent request includes fields the anchor does not currently require",
            fields: extraFields,
          },
          400,
        );
      }

      // Check that all required fields are covered (optional fields may be omitted)
      const requiredFields = record.requiredFields.filter((f) => !f.optional).map((f) => f.name);
      const missingRequired = requiredFields.filter((f) => !fields.includes(f));
      if (missingRequired.length > 0) {
        return ctx.json(
          {
            error: "missing_required_fields",
            message: "Consent must cover all required fields",
            fields: missingRequired,
          },
          400,
        );
      }

      const consent = await c.kycConsents.grant({
        sellerId: seller.id,
        anchorDomain,
        fields,
        grantedAt: Date.now(),
        revokedAt: null,
        grantedVia: "session",
        noticeVersion: "1.0",
      });

      return ctx.json(consentToResponse(consent), 201);
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
      throw err;
    }
  });

  // DELETE /seller/kyc/consent/:anchorDomain — revoke consent for an anchor
  consentApp.delete("/:anchorDomain", async (ctx) => {
    const seller = ctx.get("seller");
    const anchorDomain = ctx.req.param("anchorDomain");
    await c.kycConsents.revoke(seller.id, anchorDomain);
    return ctx.json({
      revoked: true,
      anchorDomain,
      note: "Revocation stops future data sends to this anchor. It does not erase data already held by the anchor (see issue 4.28).",
    });
  });

  app.route("/consent", consentApp);

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

  // Submit or update identity fields. Enforces per-anchor consent.
  app.put("/", async (ctx) => {
    const parsed = submitKycSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const seller = ctx.get("seller");
    const customer = customerOf(seller);
    const fields = parsed.data;

    try {
      // Check consent before sending any fields to the anchor
      const record = await c.kyc.status(customer);
      const anchorDomain = c.anchorDomain;

      if (!anchorDomain) {
        return ctx.json({ error: "server_error", message: "No anchor configured" }, 500);
      }

      // Determine which fields are about to be sent (the "send" set from 4.25)
      // These are the fields that are either new/updated in this request, or already on file
      // and the anchor requires them (requiredFields). The anchor will receive all providedFields.
      const allProvidedFields = { ...record.providedFields, ...fields };
      const fieldsToSend = Object.keys(allProvidedFields).filter((f) => record.requiredFields.some((rf) => rf.name === f));

      if (fieldsToSend.length > 0) {
        const consent = await c.kycConsents.active(seller.id, anchorDomain);
        if (!consent) {
          return ctx.json({ error: "consent_required", anchorDomain, fields: fieldsToSend }, 403);
        }

        // Check that all fields to be sent are covered by the consent
        const uncovered = fieldsToSend.filter((f) => !consent.fields.includes(f));
        if (uncovered.length > 0) {
          return ctx.json({ error: "consent_required", anchorDomain, fields: uncovered }, 403);
        }
      }

      // Values typed directly in the KYC form for this anchor in the same session
      // request count as consented for those fields only if the request carries consent: true
      // (handled by the UI calling the consent endpoint first)

      const updatedRecord = await c.kyc.submit(customer, fields);
      return ctx.json(toResponse(updatedRecord));
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
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