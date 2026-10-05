import { Hono, type MiddlewareHandler } from "hono";
import type { Container } from "../services/container";
import { buildSellerExport } from "../services/privacy-export";
import { getLogger } from "../request-context";
import { buildAuthMiddleware, type AuthVariables } from "../middleware/auth";
import { rateLimit, type RateLimitStore } from "../middleware/rate-limit";

/** At most this many exports per seller per window (issue 4.27). */
export const PRIVACY_EXPORT_LIMIT = { windowMs: 60 * 60 * 1000, max: 5 } as const;

/**
 * The export's own budget, bucketed per seller (not per IP) so one credential
 * cannot multiply it by rotating addresses. Must run after the auth middleware,
 * which is what puts the seller on the context; `privacyRoutes` does that.
 */
export function privacyExportRateLimit(store: RateLimitStore): MiddlewareHandler {
  return rateLimit({
    windowMs: PRIVACY_EXPORT_LIMIT.windowMs,
    max: PRIVACY_EXPORT_LIMIT.max,
    store,
    keyFor: (ctx) => `privacy-export:${ctx.get("seller").id}`,
  });
}

/**
 * GET /seller/profile/export - the seller's data-subject export (NDPA right of access).
 *
 * Session authentication only: an integrator's API key must not be able to pull
 * a seller's full identity, so an API key gets 403 before anything is read.
 * `exportLimit` is attached after the auth middleware so it can key on the
 * seller it has just identified. Mount this router BEFORE the profile router at
 * the same prefix, so this handler answers /export and the profile router never
 * sees it.
 */
export function privacyRoutes(
  c: Container,
  exportLimit: MiddlewareHandler,
): Hono<{ Variables: AuthVariables }> {
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
          { error: "forbidden", message: "the data export requires session authentication" },
          403,
        );
      }
      return next();
    },
    exportLimit,
  );

  app.get("/", async (ctx) => {
    const seller = ctx.get("seller");
    const now = Date.now();
    const body = await buildSellerExport(c, seller, now);

    // The sellerId only: the export's contents are personal data and never go in a log.
    getLogger(ctx).info({ event: "privacy.export", sellerId: seller.id }, "seller data export generated");

    const day = new Date(now).toISOString().slice(0, 10);
    ctx.header("Content-Disposition", `attachment; filename="quay-export-${seller.id}-${day}.json"`);
    ctx.header("Cache-Control", "no-store");
    return ctx.json(body);
  });

  return app;
}
