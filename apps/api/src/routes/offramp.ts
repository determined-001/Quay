import { Hono } from "hono";
import { getSep6Info } from "@checkout/offramp";
import type { Container } from "../services/container";
import { env } from "../env";

// Base URL for the currently configured anchor — only meaningful when
// OFFRAMP=testanchor.  Kept here so the route never imports testanchor internals.
const TESTANCHOR_BASE_URL = "https://testanchor.stellar.org";

export function offrampRoutes(c: Container): Hono {
  const app = new Hono();

  /**
   * GET /offramp/info
   *
   * Returns anchor capability info for the currently active off-ramp:
   *   - mode: "mock" | "testanchor"
   *   - withdraw: the typed /sep6/info payload (asset → types → field descriptors,
   *               min/max amounts, fee_fixed, fee_percent).
   *
   * The web form uses this to render the correct payout fields for the seller
   * without hard-coding any anchor-specific assumptions.
   *
   * When OFFRAMP=mock the response omits withdraw (the mock has no real /info).
   */
  app.get("/info", async (ctx) => {
    if (env.offramp === "mock") {
      return ctx.json({
        mode: "mock" as const,
        withdraw: null,
      });
    }

    try {
      const info = await getSep6Info(TESTANCHOR_BASE_URL);
      return ctx.json({ mode: "testanchor" as const, withdraw: info.withdraw });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ctx.json({ error: `Failed to fetch anchor info: ${message}` }, 502);
    }
  });

  return app;
}
