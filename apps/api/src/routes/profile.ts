import { Hono } from "hono";
import { z } from "zod";
import { customerOf } from "../services/link-service";
import type { Container } from "../services/container";
import { buildAuthMiddleware, type AuthVariables } from "../middleware/auth";

const deleteProfileSchema = z.object({
  confirm: z.string().min(1),
});

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
  );

  app.delete("/", async (ctx) => {
    if (ctx.get("authKind") !== "session") {
      return ctx.json(
        {
          error: "forbidden",
          message: "Data erasure requires an interactive session and cannot be performed with an API key",
        },
        403,
      );
    }

    const seller = ctx.get("seller");
    const parsed = deleteProfileSchema.safeParse(await safeJson(ctx));
    if (!parsed.success || parsed.data.confirm !== seller.wallet) {
      return ctx.json(
        {
          error: "invalid_confirmation",
          message: "Request body confirm field must match the authenticated seller wallet address",
        },
        400,
      );
    }

    // Erase downstream anchors first while session is still intact
    let anchors: Awaited<ReturnType<typeof c.kyc.erase>> = [];
    try {
      anchors = await c.kyc.erase(customerOf(seller));
    } catch {
      anchors = [];
    }

    // Local DB cleanup
    if (c.kycRepo) {
      await c.kycRepo.delete(seller.id);
    }
    await c.anchorSessions.deleteBySeller(seller.id);
    await c.sellers.clearPayoutFields(seller.id);

    return ctx.json({
      erased: ["profile", "kyc", "consents", "anchor_sessions", "payout_fields"],
      anchors,
      retained: [
        { what: "payment history", why: "public on the Stellar ledger" },
        { what: "database backups", why: "expire after BACKUP_RETENTION_DAYS" },
      ],
    });
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
