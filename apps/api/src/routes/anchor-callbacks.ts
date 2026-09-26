import { Hono } from "hono";
import { createHash } from "node:crypto";
import { fetchStellarToml, toFieldSpecs, toKycStatus, verifySep12CallbackSignature } from "@checkout/offramp";
import type { KycRecord } from "@checkout/core";
import type { Container } from "../services/container";

/**
 * Handles incoming push callbacks from anchors regarding customer KYC status (SEP-12).
 *
 * Endpoint: POST /anchor-callbacks/sep12/:anchorDomain/:token
 * Unauthenticated (no session/API-key), protected by:
 * 1. Cryptographic ED25519 signature check against the anchor's published SIGNING_KEY from stellar.toml.
 * 2. High-entropy one-time/per-customer callback token hash lookup.
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

    const host = ctx.req.header("host") ?? "";
    const rawBody = await ctx.req.text();

    let signingKey: string | null = null;
    try {
      const discovery = await fetchStellarToml(anchorDomain, {
        logger: c.logger,
      });
      signingKey = discovery.signingKey;
    } catch (err) {
      c.logger.warn({ anchorDomain, err }, "Failed to fetch TOML for anchor callback");
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

    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (!c.kycRepo) {
      return ctx.json({ error: "kyc_not_configured" }, 500);
    }

    const record = await c.kycRepo.getByCallbackTokenHash(tokenHash);
    if (!record) {
      return ctx.json({ error: "invalid_callback_token" }, 404);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return ctx.json({ error: "invalid_json" }, 400);
    }

    if (parsed.id && record.customerId && parsed.id !== record.customerId) {
      return ctx.json({ error: "customer_id_mismatch" }, 400);
    }

    const updatedRecord: KycRecord = {
      ...record,
      customerId: parsed.id ?? record.customerId,
      status: toKycStatus(parsed.status),
      requiredFields: toFieldSpecs(parsed.fields),
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
