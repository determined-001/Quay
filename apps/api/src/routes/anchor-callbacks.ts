import { Hono } from "hono";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  fetchStellarToml,
  toFieldSpecs,
  toKycStatus,
  toProvidedFieldStatus,
  verifySep12CallbackSignature,
} from "@checkout/offramp";
import type { KycRecord } from "@checkout/core";
import type { Container } from "../services/container";

/** The `GET /customer` body an anchor POSTs to the callback (SEP-12). */
const callbackBodySchema = z.object({
  id: z.string().min(1).optional(),
  status: z.string().min(1),
  fields: z.record(z.string(), z.any()).optional(),
  provided_fields: z.record(z.string(), z.any()).optional(),
  message: z.string().nullish(),
});

/**
 * Handles incoming push callbacks from anchors regarding customer KYC status (SEP-12).
 *
 * Endpoint: POST /anchor-callbacks/sep12/:anchorDomain/:token
 * Unauthenticated (no session/API-key), protected by:
 * 1. A high-entropy per-seller callback token, stored only as a hash. The URL identifies the
 *    seller, and the path's anchor domain must be the one that token was issued for.
 * 2. A cryptographic ED25519 signature check against the SIGNING_KEY published in the stellar.toml
 *    of that same anchor.
 * 3. A fresh timestamp, and a body `id` matching the stored customer id.
 *
 * Order matters: the stellar.toml is only fetched for an anchor Quay itself registered the callback
 * with. Looking it up from the caller-supplied path first would let any unauthenticated caller make
 * this endpoint fetch an arbitrary domain.
 */
export function anchorCallbacksRoutes(c: Container): Hono {
  const app = new Hono();

  app.post("/sep12/:anchorDomain/:token", async (ctx) => {
    const { anchorDomain, token } = ctx.req.param();
    if (!anchorDomain || !token) {
      return ctx.json({ error: "missing_parameters" }, 400);
    }

    const sigHeader = ctx.req.header("signature") ?? ctx.req.header("x-stellar-signature");
    if (!sigHeader) {
      return ctx.json({ error: "missing_signature" }, 401);
    }

    if (!c.kycRepo) {
      return ctx.json({ error: "kyc_not_configured" }, 500);
    }

    const host = ctx.req.header("host") ?? "";
    const rawBody = await ctx.req.text();

    // Cheap, local checks first: nothing below touches the network until the token is known.
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const record = await c.kycRepo.getByCallbackTokenHash(tokenHash);
    if (!record || record.anchorDomain.toLowerCase() !== anchorDomain.toLowerCase()) {
      // Same answer for an unknown token and for a token used under the wrong anchor.
      return ctx.json({ error: "invalid_callback_token" }, 404);
    }

    let signingKey: string | null = null;
    try {
      const discovery = await fetchStellarToml(record.anchorDomain, {
        logger: c.logger,
      });
      signingKey = discovery.signingKey;
    } catch (err) {
      c.logger.warn({ anchorDomain: record.anchorDomain, err }, "Failed to fetch TOML for anchor callback");
      return ctx.json({ error: "unknown_anchor" }, 400);
    }

    if (!signingKey) {
      return ctx.json({ error: "missing_anchor_signing_key" }, 400);
    }

    const isValid = verifySep12CallbackSignature({
      header: sigHeader,
      body: rawBody,
      host,
      signingKey,
    });

    if (!isValid) {
      return ctx.json({ error: "invalid_signature" }, 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return ctx.json({ error: "invalid_json" }, 400);
    }
    const parsedBody = callbackBodySchema.safeParse(json);
    if (!parsedBody.success) {
      return ctx.json({ error: "invalid_body" }, 400);
    }
    const parsed = parsedBody.data;

    // A callback is only ever registered for a record that already has a customer
    // id, so one without it cannot be legitimate; and the body id, when sent, must
    // be that customer's. The anchor must never get to choose which id we store.
    if (!record.customerId || (parsed.id && parsed.id !== record.customerId)) {
      return ctx.json({ error: "customer_id_mismatch" }, 400);
    }

    const updatedRecord: KycRecord = {
      ...record,
      customerId: record.customerId,
      status: toKycStatus(parsed.status),
      requiredFields: toFieldSpecs(parsed.fields),
      providedFieldStatus: toProvidedFieldStatus(parsed.provided_fields),
      message: parsed.message ?? null,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };

    await c.kycRepo.save(updatedRecord);
    c.logger.info(
      { sellerId: record.sellerId, customerId: updatedRecord.customerId, status: updatedRecord.status },
      "Updated KYC status via anchor callback",
    );

    return ctx.json({ ok: true });
  });

  return app;
}
