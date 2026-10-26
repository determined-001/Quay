import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  AnchorAuthRequiredError,
  KycRequiredError,
  type KycFieldSpec,
  type KycRecord,
  type KycConsent,
  type KycUploadFile,
} from "@checkout/core";
import {
  AnchorCapabilityError,
  AnchorConfigError,
  AnchorHttpError,
  SEP24_PREFILL_FIELDS,
  isPrefillField,
} from "@checkout/offramp";
import { env } from "../env";
import type { Container } from "../services/container";
import { anchorFailure } from "../services/link-service";
import { getLogger } from "../request-context";
import { recordAnchorAuthRequired } from "../metrics";
import { customerOf } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";
import { kycDisclosureFields, sellerKyc } from "../db/schema";
import { auditActor } from "../services/pii-audit";

/**
 * Bounds on what a seller can submit, because the whole map is forwarded to the
 * anchor: at most 50 fields, SEP-9 style snake_case names, values up to 1,000
 * characters (issue 8.17). Real SEP-9 fields are short; a legitimate KYC form
 * is nowhere near these limits.
 */
export const KYC_MAX_FIELDS = 50;
export const KYC_MAX_VALUE_LENGTH = 1000;
const submitKycSchema = z
  .record(z.string().regex(/^[a-z0-9_.]{1,64}$/), z.string().max(KYC_MAX_VALUE_LENGTH))
  .refine((fields) => Object.keys(fields).length <= KYC_MAX_FIELDS, {
    message: `at most ${KYC_MAX_FIELDS} fields`,
  });

const grantConsentSchema = z.object({
  anchorDomain: z.string().min(1),
  fields: z.array(z.string()).min(1),
});

const prefillConsentSchema = z.object({
  fields: z.array(z.string().regex(/^[a-z0-9_.]{1,64}$/)).max(KYC_MAX_FIELDS),
});

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

/**
 * `providedFields` holds the seller's decrypted identity. A programmatic API key
 * has no need to read it back (consent, disclosures and file upload already
 * refuse keys), so only a signed-in seller session gets the values; a key gets
 * the status and what is still required (issue 8.17).
 */
function toResponse(record: KycRecord, authKind: "session" | "api_key" | undefined) {
  return {
    status: record.status,
    requiredFields: record.requiredFields,
    providedFields: authKind === "api_key" ? {} : record.providedFields,
    message: record.message,
    lastSyncedAt: record.lastSyncedAt,
  };
}

function safeAnchorStatus(value: string | null | undefined): string {
  return value === "ACCEPTED" || value === "REJECTED" || value === "PROCESSING" ||
    value === "NEEDS_INFO" || value === "VERIFICATION_REQUIRED" ? value : "UNKNOWN";
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
/**
 * An anchor that is down, unreachable or answering with an error is a 502 the
 * dashboard can explain, not a 500. The anchor's own response text never
 * reaches the client (issue 4.36); unknown errors are left to `app.onError`.
 */
function anchorFailureResponse(ctx: Context<{ Variables: AuthVariables }>, err: unknown) {
  if (
    !(err instanceof AnchorHttpError) &&
    !(err instanceof AnchorConfigError) &&
    !(err instanceof AnchorCapabilityError) &&
    !isNetworkError(err)
  ) {
    return null;
  }
  const failure = anchorFailure(err, getLogger(ctx));
  return ctx.json({ error: failure.message, ...failure.extra }, 502);
}

/** `fetch` rejects with a TypeError on DNS, connection and TLS failures, and with an AbortError/TimeoutError on timeouts. */
function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export function kycRoutes(
  c: Container,
  kycWriteLimit: MiddlewareHandler = async (_ctx, next) => next(),
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Identity data must never sit in a shared cache or the browser's history.
  app.use("*", async (ctx, next) => {
    await next();
    ctx.header("Cache-Control", "no-store");
  });

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
      const failed = anchorFailureResponse(ctx, err);
      if (failed) return failed;
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

  // Which stored SEP-9 values the seller lets the anchor's SEP-24 form open pre-filled with
  // (issue 3.17). A separate consent from /consent above, which covers what Quay posts to the
  // anchor's SEP-12 endpoint. Session auth only, like every consent surface; off until turned on.
  const prefillApp = new Hono<{ Variables: AuthVariables }>();

  prefillApp.use("*", async (ctx, next) => {
    if (ctx.get("authKind") === "api_key") {
      return ctx.json({ error: "forbidden", message: "prefill consent requires session authentication" }, 403);
    }
    await next();
  });

  // GET /seller/kyc/prefill-consent — what may be shared, what is on file, what is consented
  prefillApp.get("/", async (ctx) => {
    const seller = ctx.get("seller");
    const anchorDomain = c.anchorDomain;
    if (!anchorDomain || !c.prefillConsents) return ctx.json({ error: "anchor_unavailable" }, 404);
    const consent = await c.prefillConsents.get(seller.id, anchorDomain);
    // Names only. An allowlisted field the seller has no value for is not offered at all.
    let available: string[] = [];
    if (c.kycRepo) {
      const type = (await c.kyc.resolveType?.(customerOf(seller))) ?? null;
      const record = await c.kycRepo.get(seller.id, anchorDomain, type);
      if (record) {
        available = SEP24_PREFILL_FIELDS.filter((name) => (record.providedFields[name] ?? "").trim() !== "");
      }
    }
    return ctx.json({
      anchorDomain,
      available,
      // Withdrawn or never granted: nothing is shared.
      fields: consent?.fields ?? [],
      grantedAt: consent?.grantedAt ?? null,
    });
  });

  // PUT /seller/kyc/prefill-consent — replace the consented fields; [] withdraws consent
  prefillApp.put("/", async (ctx) => {
    const seller = ctx.get("seller");
    const anchorDomain = c.anchorDomain;
    if (!anchorDomain || !c.prefillConsents) return ctx.json({ error: "anchor_unavailable" }, 404);
    const parsed = prefillConsentSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    const fields = [...new Set(parsed.data.fields)];
    const notAllowed = fields.filter((name) => !isPrefillField(name));
    if (notAllowed.length > 0) {
      return ctx.json(
        { error: "invalid_fields", message: "These fields cannot be shared to pre-fill an anchor's form", fields: notAllowed },
        400,
      );
    }
    const consent = await c.prefillConsents.set(seller.id, anchorDomain, fields);
    return ctx.json({
      anchorDomain,
      fields: consent?.fields ?? [],
      grantedAt: consent?.grantedAt ?? null,
    });
  });

  app.route("/prefill-consent", prefillApp);

  // Disclosure history is seller-owned metadata. Never read the encrypted field
  // values into this response, and never infer a send time from a status sync.
  app.get("/disclosures", async (ctx) => {
    if (ctx.get("authKind") === "api_key") {
      return ctx.json({ error: "forbidden", message: "disclosures require session authentication" }, 403);
    }
    const sellerId = ctx.get("seller").id;
    const sent = await c.db.select().from(kycDisclosureFields).where(eq(kycDisclosureFields.sellerId, sellerId));
    if (sent.length === 0) return ctx.json([]);

    const domains = [...new Set(sent.map((field) => field.anchorDomain))];
    const records = await c.db.select({
      anchorDomain: sellerKyc.anchorDomain,
      status: sellerKyc.status,
      providedFieldStatus: sellerKyc.providedFieldStatus,
    }).from(sellerKyc).where(and(eq(sellerKyc.sellerId, sellerId), inArray(sellerKyc.anchorDomain, domains)));
    const consents = await c.kycConsents.list(sellerId);
    const byDomain = new Map(records.map((record) => [record.anchorDomain, record]));
    const disclosures = domains.sort().map((anchorDomain) => {
      const record = byDomain.get(anchorDomain);
      const latestConsent = consents.filter((consent) => consent.anchorDomain === anchorDomain)
        .sort((a, b) => b.grantedAt - a.grantedAt)[0];
      const statuses = record?.providedFieldStatus
        ? JSON.parse(record.providedFieldStatus) as Array<{ name: string; status: string | null; error: string | null }>
        : [];
      return {
        anchorDomain,
        status: record?.status ?? "unsubmitted",
        fields: sent.filter((field) => field.anchorDomain === anchorDomain)
          .sort((a, b) => a.fieldName.localeCompare(b.fieldName))
          .map((field) => ({
            name: field.fieldName,
            sentAt: field.sentAt,
            anchorStatus: safeAnchorStatus(statuses.find((status) => status.name === field.fieldName)?.status),
          })),
        consent: latestConsent
          ? { grantedAt: latestConsent.grantedAt, revokedAt: latestConsent.revokedAt }
          : null,
      };
    });
    return ctx.json(disclosures);
  });

  // SEP-12 DELETE applies to the seller's customer at the configured anchor.
  // Do not accept an arbitrary URL or account from the browser.
  app.delete("/disclosures/:anchorDomain", async (ctx) => {
    if (ctx.get("authKind") === "api_key") {
      return ctx.json({ error: "forbidden", message: "deletion requires session authentication" }, 403);
    }
    const anchorDomain = ctx.req.param("anchorDomain");
    const known = c.anchorDomains ? await c.anchorDomains() : c.anchorDomain ? [c.anchorDomain] : [];
    if (!known.includes(anchorDomain) || !c.deleteAnchorCustomer) {
      return ctx.json({ error: "anchor_unavailable" }, 404);
    }
    const seller = ctx.get("seller");
    const customer = customerOf(seller);
    try {
      await c.kycConsents.revoke(seller.id, anchorDomain);
      const anchorResult = await c.deleteAnchorCustomer(customer, anchorDomain);
      await c.db.delete(sellerKyc).where(and(eq(sellerKyc.sellerId, seller.id), eq(sellerKyc.anchorDomain, anchorDomain)));
      await c.db.delete(kycDisclosureFields).where(and(eq(kycDisclosureFields.sellerId, seller.id), eq(kycDisclosureFields.anchorDomain, anchorDomain)));
      return ctx.json({ anchorDomain, anchorResult, localDataErased: true });
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
      throw err;
    }
  });

  // Current requirements + status, re-synced from the anchor (or served from cache).
  app.get("/", async (ctx) => {
    try {
      const refresh = ctx.req.query("refresh") === "1" || ctx.req.query("refresh") === "true";
      const maxAgeMs = refresh ? 0 : (c.config.kycStatusCacheMs ?? 60_000);
      const record = await c.kyc.status(customerOf(ctx.get("seller")), { maxAgeMs });
      const body = toResponse(record, ctx.get("authKind"));
      // Names of the identity fields whose values this response carries. An API
      // key gets none (see toResponse), so its row says it only saw the status.
      await c.piiAudit?.record({
        ...auditActor(ctx),
        action: "kyc.read",
        fields: Object.keys(body.providedFields),
      });
      return ctx.json(body);
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) {
        recordAnchorAuthRequired("kyc_get");
        return ctx.json({ error: "anchor_auth_required" }, 403);
      }
      const failed = anchorFailureResponse(ctx, err);
      if (failed) return failed;
      throw err;
    }
  });

  // Submit or update identity fields. Enforces per-anchor consent.
  app.put("/", kycWriteLimit, async (ctx) => {
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

      const isFirstSubmission = record.requiredFields.length === 0;
      let fieldsToSendToAnchor: Record<string, string>;

      if (isFirstSubmission) {
        // On first submission, requiredFields is empty because discovery has not run yet.
        // Never send unconsented profile fields to the anchor:
        // - Without active consent, send no fields ({}) so discovery runs safely (same as PUT {})
        // - If active consent exists, transmit only fields covered by that consent
        const consent = await c.kycConsents.active(seller.id, anchorDomain);
        if (!consent) {
          fieldsToSendToAnchor = {};
        } else {
          fieldsToSendToAnchor = Object.fromEntries(
            Object.entries(fields).filter(([k]) => consent.fields.includes(k)),
          );
        }
      } else {
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
        fieldsToSendToAnchor = fields;
      }

      // Values typed directly in the KYC form for this anchor in the same session
      // request count as consented for those fields only if the request carries consent: true
      // (handled by the UI calling the consent endpoint first)

      const updatedRecord = await c.kyc.submit(customer, fieldsToSendToAnchor);
      if (updatedRecord.sentFields.length > 0) {
        const sentAt = Date.now();
        await c.db.insert(kycDisclosureFields).values(updatedRecord.sentFields.map((fieldName) => ({
          sellerId: seller.id,
          anchorDomain,
          fieldName,
          sentAt,
        }))).onConflictDoUpdate({
          target: [kycDisclosureFields.sellerId, kycDisclosureFields.anchorDomain, kycDisclosureFields.fieldName],
          set: { sentAt: sql`excluded.sent_at` },
        });
      }
      await c.sellers.touchLastActive?.(seller.id);
      await c.piiAudit?.record({ ...auditActor(ctx), action: "kyc.submit", fields: Object.keys(fields) });
      return ctx.json(toResponse(updatedRecord, ctx.get("authKind")));
    } catch (err) {
      if (err instanceof AnchorAuthRequiredError) {
        recordAnchorAuthRequired("kyc_put");
        return ctx.json({ error: "anchor_auth_required" }, 403);
      }
      if (err instanceof KycRequiredError) {
        return ctx.json({ error: "kyc_required", missingFields: err.missingFields }, 422);
      }
      const failed = anchorFailureResponse(ctx, err);
      if (failed) return failed;
      throw err;
    }
  });

  // Upload binary KYC file fields (e.g. photo_id_front, photo_id_back, ...).
  // Streams straight into the anchor and drops the bytes immediately.
  // Never persists or logs uploaded file contents.
  app.put(
    "/files",
    bodyLimit({
      maxSize: env.kycMaxUploadBytes,
      onError: (ctx) => ctx.json({ error: "payload_too_large" }, 413),
    }),
    async (ctx) => {
      // Identity documents are only ever uploaded by the seller themselves, from their own
      // session. An API key (a programmatic integration) has no business sending an ID photo.
      if (ctx.get("authKind") === "api_key") {
        return ctx.json(
          { error: "forbidden", message: "file uploads require session authentication" },
          403,
        );
      }
      const seller = ctx.get("seller");
      const customer = customerOf(seller);
      let record: KycRecord;
      try {
        record = await c.kyc.status(customer);
      } catch (err) {
        if (err instanceof AnchorAuthRequiredError) {
          recordAnchorAuthRequired("kyc_put");
          return ctx.json({ error: "anchor_auth_required" }, 403);
        }
        const failed = anchorFailureResponse(ctx, err);
        if (failed) return failed;
        throw err;
      }

      const requestedBinaryFields = new Map<string, KycFieldSpec>(
        record.requiredFields.filter((f) => f.type === "binary").map((f) => [f.name, f]),
      );

      let body: Record<string, unknown>;
      try {
        body = (await ctx.req.parseBody({ all: true })) as Record<string, unknown>;
      } catch {
        return ctx.json({ error: "invalid_body" }, 400);
      }

      const uploadFiles: KycUploadFile[] = [];
      const keys = Object.keys(body);
      if (keys.length === 0) {
        return ctx.json({ error: "no_files" }, 400);
      }

      for (const [key, value] of Object.entries(body)) {
        if (!requestedBinaryFields.has(key)) {
          return ctx.json({ error: "unrequested_field", field: key }, 400);
        }
        const fileValues = Array.isArray(value) ? value : [value];
        if (fileValues.length > 1) {
          return ctx.json({ error: "too_many_files", field: key }, 400);
        }
        for (const item of fileValues) {
          if (!(item instanceof Blob) && (typeof item !== "object" || item === null || !("arrayBuffer" in item))) {
            return ctx.json({ error: "invalid_file", field: key }, 400);
          }
          const blob = item as Blob;
          const mimeType = blob.type || "application/octet-stream";
          if (!ALLOWED_MIME_TYPES.has(mimeType)) {
            return ctx.json({ error: "invalid_mime_type", field: key, mimeType }, 400);
          }
          if (blob.size > env.kycMaxUploadBytes) {
            return ctx.json({ error: "payload_too_large" }, 413);
          }
          const filename =
            (item as File).name ||
            `${key}.${mimeType === "image/png" ? "png" : mimeType === "application/pdf" ? "pdf" : "jpg"}`;
          uploadFiles.push({
            name: key,
            blob,
            filename,
          });
        }
      }

      if (uploadFiles.length === 0) {
        return ctx.json({ error: "no_files" }, 400);
      }

      // Same per-anchor consent gate as PUT /: no field reaches the anchor
      // (files included) unless the seller consented to that specific field.
      const anchorDomain = c.anchorDomain;
      if (!anchorDomain) {
        return ctx.json({ error: "server_error", message: "No anchor configured" }, 500);
      }
      const uploadedFields = [...new Set(uploadFiles.map((f) => f.name))];
      const consent = await c.kycConsents.active(seller.id, anchorDomain);
      const uncovered = consent ? uploadedFields.filter((f) => !consent.fields.includes(f)) : uploadedFields;
      if (uncovered.length > 0) {
        return ctx.json({ error: "consent_required", anchorDomain, fields: uncovered }, 403);
      }

      try {
        const updated = await c.kyc.submitFiles(customer, uploadFiles);
        await c.sellers.touchLastActive?.(seller.id);
        await c.piiAudit?.record({ ...auditActor(ctx), action: "kyc.submit", fields: uploadedFields });
        return ctx.json(toResponse(updated, "session"));
      } catch (err) {
        if (err instanceof AnchorAuthRequiredError) {
          recordAnchorAuthRequired("kyc_put");
          return ctx.json({ error: "anchor_auth_required" }, 403);
        }
        if (err instanceof KycRequiredError) {
          return ctx.json({ error: "kyc_required", missingFields: err.missingFields }, 422);
        }
        const failed = anchorFailureResponse(ctx, err);
        if (failed) return failed;
        throw err;
      }
    },
  );

  return app;
}

async function safeJson(ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    return {};
  }
}
