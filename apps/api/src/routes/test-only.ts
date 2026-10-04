import { Hono } from "hono";
import { z } from "zod";
import { matchPayment, type NormalizedPayment } from "@checkout/core";
import type { Container } from "../services/container";
import { getLogger, type AppEnv } from "../request-context";

/**
 * E2E-only backdoors (issue 5.7). Mounted at /__test__ ONLY when
 * `E2E_TEST_MODE=1`, which env.ts refuses to combine with
 * NODE_ENV=production or STELLAR_NETWORK=public — a deployment cannot carry
 * these routes.
 *
 * Two routes, and an honest account of what each one does and does not prove:
 *
 * `POST /session` mints a real session JWT for a seeded seller. It bypasses
 * SEP-10 — no wallet signs anything — so it proves nothing about
 * authentication. What it preserves is that auth EXISTS: the suite drives
 * `/links` and cash-out through `requireSeller` with a genuine token, rather
 * than the routes being unlocked for tests. The SEP-10 challenge flow itself
 * is covered by unit tests against the challenge service.
 *
 * `POST /pay` marks a link paid by injecting a synthetic NormalizedPayment at
 * the exact point the ledger watcher would deliver a real one: through
 * `matchPayment` (the real matcher, with the same open-links lookup shape the
 * watcher builds) and `service.applyMatch` (the real state machine, webhook
 * enqueueing and persistence). What it does NOT verify: that Horizon was
 * polled, that a transaction existed on any ledger, or that normalize()
 * decoded it correctly — the payment is conjured, not observed. Those layers
 * are covered by the watcher/normalizer unit tests; this route exists so the
 * end-to-end suite can cross the "money arrives" boundary without a network.
 */
export function testOnlyRoutes(c: Container) {
  const app = new Hono<AppEnv>();

  const sessionSchema = z.object({
    // A well-formed (not necessarily funded or existing) testnet wallet is
    // fine — nothing in test mode looks it up on Horizon. The default is a
    // throwaway keypair generated once for this suite; it matches the
    // DEFAULT_SELLER_WALLET the Playwright config boots the API with.
    wallet: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/)
      .default("GB4UZMDW2P4WITZ3DFPFIU6B7NRHBDDP5UQ2BUENI3LJQOX2YC2U7FJB"),
    name: z.string().trim().min(1).max(120).default("E2E Seller"),
  });

  app.post("/session", async (ctx) => {
    const log = getLogger(ctx);
    const parsed = sessionSchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const seller = await c.sellers.ensureDefault(parsed.data.wallet, parsed.data.name);
    const issued = await c.auth.session.issue({ sub: seller.wallet, sellerId: seller.id });
    log.info({ event: "e2e.session.minted", sellerId: seller.id }, "e2e session minted");
    return ctx.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
      sellerId: seller.id,
      wallet: seller.wallet,
    });
  });

  const paySchema = z.object({
    linkId: z.string().trim().min(1),
    /** Override the delivered amount — lets a spec exercise underpayment. */
    amount: z.string().trim().min(1).optional(),
  });

  app.post("/pay", async (ctx) => {
    const log = getLogger(ctx);
    const parsed = paySchema.safeParse(await ctx.req.json().catch(() => ({})));
    if (!parsed.success) {
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const link = await c.links.findById(parsed.data.linkId);
    if (!link) return ctx.json({ error: "not_found" }, 404);

    // The same synthetic shape a normalized Horizon payment record has,
    // correlated the way the link asks to be correlated: memo mode carries
    // the reference as a text memo; muxed mode carries the SEP-23 id and no
    // memo — mirroring StellarRail.buildRequest.
    const nonce = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffff).toString(16)}`;
    const payment: NormalizedPayment = {
      txHash: `e2e${nonce}`.padEnd(64, "0"),
      pagingToken: `${Date.now()}-e2e`,
      from: "GAQODF5S6XWEB4PXX3EMDCX7NPS6ISVLMWFEBLDIVYPILDT2RFHNGBUY",
      to: link.destination,
      amount: parsed.data.amount ?? link.amount,
      asset: link.asset,
      memo: link.muxedId ? null : link.reference,
      memoType: link.muxedId ? "none" : "text",
      toMuxedId: link.muxedId ?? null,
      createdAt: new Date().toISOString(),
      ledger: 1,
    };

    // The watcher's own lookup shape: match only against this link, exactly
    // as `WatcherLoop.tick` matches against the destination's open set.
    const outcome = matchPayment(
      payment,
      (ref) => (ref === link.reference ? link : undefined),
      (id) => (id === link.muxedId ? link : undefined),
    );

    let becamePaid = false;
    if (outcome.kind === "paid" || outcome.kind === "underpaid") {
      becamePaid = await c.service.applyMatch(payment, outcome, { logger: log });
    }
    log.info(
      { event: "e2e.payment.injected", linkId: link.id, outcome: outcome.kind, becamePaid },
      "synthetic payment injected",
    );
    return ctx.json({ outcome: outcome.kind, becamePaid, txHash: payment.txHash });
  });

  return app;
}
