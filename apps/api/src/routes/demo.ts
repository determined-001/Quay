import { Hono } from "hono";
import type { Container } from "../services/container";
import { env } from "../env";
import { requireSeller, type AuthedVariables } from "../middleware/auth";
export function demoRoutes(container: Container): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();

  if (env.network !== "testnet") {
    app.all("*", (ctx) =>
      ctx.json({ error: "demo endpoints are only available on testnet" }, 403),
    );
    return app;
  }

  const auth = requireSeller({
    session: container.auth.session,
    sellers: container.sellers,
    revocations: container.auth.revocations,
  });
  app.post("/reset", auth, async (ctx) => {
    const deleted = await container.links.deleteDemo(ctx.get("seller").id);
    return ctx.json({ ok: true, deleted });
  });

  return app;
}
