import { Hono } from "hono";
import { z } from "zod";
import { sep9Field, validateSep9Value, type ProfileField } from "@checkout/core";
import type { Container } from "../services/container";
import { buildAuthMiddleware, type AuthVariables } from "../middleware/auth";

const putProfileSchema = z.record(z.string(), z.string());

function toResponse(fields: ProfileField[]) {
  return {
    fields: fields.map((f) => ({
      field: f.field,
      value: f.value,
      source: f.source,
      updatedAt: f.updatedAt,
    })),
  };
}

/**
 * The seller's reusable, anchor-independent identity profile (issue 4.23).
 *
 * Session authentication only: the profile is the seller's own identity data,
 * so an integrator's API key must not be able to read or rewrite it (403).
 * Available only when the deployment has a real anchor and KYC_ENCRYPTION_KEY,
 * which is when the encrypted store exists; otherwise 503.
 */
export function profileRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
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
    async (ctx, next) => {
      if (ctx.get("authKind") !== "session") {
        return ctx.json(
          { error: "forbidden", message: "the seller profile requires session authentication" },
          403,
        );
      }
      if (!c.sellerProfile) {
        return ctx.json(
          {
            error: "profile_unavailable",
            message: "the seller profile needs a real anchor (OFFRAMP=testanchor|anchor) and KYC_ENCRYPTION_KEY",
          },
          503,
        );
      }
      return next();
    },
  );

  // GET /seller/profile — every stored field with its source and last change.
  app.get("/", async (ctx) => {
    const fields = await c.sellerProfile!.list(ctx.get("seller").id);
    return ctx.json(toResponse(fields));
  });

  // PUT /seller/profile — validate and store; nothing is written unless every field is valid.
  app.put("/", async (ctx) => {
    const parsed = putProfileSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const reasons: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.data)) {
      const entry = sep9Field(name);
      if (!entry) {
        reasons[name] = "not a SEP-9 field";
      } else if (entry.type === "binary") {
        reasons[name] = "binary fields are not accepted";
      } else if (value === "") {
        reasons[name] = "value must not be empty";
      } else {
        const result = validateSep9Value(entry, value);
        if (!result.ok) reasons[name] = result.reason;
      }
    }
    if (Object.keys(reasons).length > 0) {
      return ctx.json({ error: "invalid_fields", fields: reasons }, 422);
    }

    const seller = ctx.get("seller");
    await c.sellerProfile!.upsert(seller.id, parsed.data, "seller");
    return ctx.json(toResponse(await c.sellerProfile!.list(seller.id)));
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
