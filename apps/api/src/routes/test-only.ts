import { Hono } from "hono";
import type { MatchOutcome, NormalizedPayment } from "@checkout/core";
import type { Container } from "../services/container";

/**
 * Test-only routes for the Playwright e2e suite (issue 5.7). Mounted only
 * when `E2E_TEST_MODE=1` (see `env.ts`'s startup guard, which refuses to
 * boot with this set under `NODE_ENV=production`) - never reachable in a
 * real deployment.
 *
 * `POST /simulate-payment` settles a link through the *exact same*
 * `LinkService.applyMatch` path a real on-chain settlement uses, with a
 * synthetic `NormalizedPayment` standing in for one the watcher would
 * otherwise have observed on-chain. This is a deliberate substitution, not a
 * shortcut around the thing being tested: the e2e suite's job is to verify
 * the API's settlement/status-transition/webhook logic and the web UI's
 * rendering of each state, both of which run identically either way. What it
 * does *not* verify is the watcher/payment-matching path itself (fetching
 * from Horizon, memo correlation) - that has its own unit and integration
 * coverage elsewhere, and exercising it for real here would require a live
 * Stellar network, which this suite must run without.
 */
export function testOnlyRoutes(c: Container): Hono {
  const app = new Hono();

  app.post("/simulate-payment", async (ctx) => {
    const body = (await ctx.req.json().catch(() => ({}))) as { linkId?: unknown };
    const linkId = typeof body.linkId === "string" ? body.linkId : undefined;
    if (!linkId) return ctx.json({ error: "invalid_body" }, 400);

    const link = await c.links.findById(linkId);
    if (!link) return ctx.json({ error: "not_found" }, 404);

    const payment: NormalizedPayment = {
      txHash: `e2e_${linkId}`,
      pagingToken: "0",
      from: "GE2EBUYER0000000000000000000000000000000000000000000000A",
      to: link.destination,
      amount: link.amount,
      asset: link.asset,
      memo: link.reference,
      memoType: "text",
      createdAt: new Date().toISOString(),
    };
    const outcome: MatchOutcome = { kind: "paid", link, overpaid: false };
    const becamePaid = await c.service.applyMatch(payment, outcome);
    return ctx.json({ becamePaid });
  });

  return app;
}
