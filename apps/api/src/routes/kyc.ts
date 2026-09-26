import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AnchorAuthRequiredError,
  KycRequiredError,
  type KycFieldSpec,
  type KycRecord,
  type KycUploadFile,
} from "@checkout/core";
import { env } from "../env";
import type { Container } from "../services/container";
import { customerOf } from "../services/link-service";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";

const submitKycSchema = z.record(z.string(), z.string());

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

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
 * All routes are authenticated and scoped (`offramp:initiate`).
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
      const customer = customerOf(ctx.get("seller"));
      let record: KycRecord;
      try {
        record = await c.kyc.status(customer);
      } catch (err) {
        if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
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

      try {
        const updated = await c.kyc.submitFiles(customer, uploadFiles);
        return ctx.json(toResponse(updated));
      } catch (err) {
        if (err instanceof AnchorAuthRequiredError) return ctx.json({ error: "anchor_auth_required" }, 403);
        if (err instanceof KycRequiredError) {
          return ctx.json({ error: "kyc_required", missingFields: err.missingFields }, 422);
        }
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

