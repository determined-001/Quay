import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { createContainer } from "./services/container";
import { linkRoutes } from "./routes/links";
import { webhookRoutes } from "./routes/webhooks";
import { rateLimit } from "./middleware/rate-limit";
import { requestContext, type AppEnv } from "./request-context";

async function main(): Promise<void> {
  const container = await createContainer();
  const logger = container.logger;

  const app = new Hono<AppEnv>();
  // requestContext MUST run before rate-limit so a 429 still has a requestId
  // and so rate-limit responses (when we add instrumentation later) can log
  // through the bound child logger.
  app.use("*", requestContext(logger));
  app.use("*", cors({ origin: env.corsOrigins, allowMethods: ["GET", "POST", "OPTIONS"] }));
  app.use("*", rateLimit({ windowMs: env.rateLimitWindowMs, max: env.rateLimitMax }));

  app.get("/health", (ctx) =>
    ctx.json({
      ok: true,
      network: container.config.network,
      sellerWallet: container.config.sellerWallet,
    }),
  );

  app.route("/links", linkRoutes(container));
  app.route("/webhooks", webhookRoutes(container));

  container.start();

  serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
    logger.info(
      { event: "api.listening", port: info.port, network: container.config.network, horizonUrl: container.config.horizonUrl, sellerWallet: container.config.sellerWallet },
      `listening on http://localhost:${info.port}`,
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ event: "api.shutdown", signal }, "shutting down");
    container.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // Logger may not be available yet (boot-time failure); fall back to stderr.
  process.stderr.write(`[api] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
