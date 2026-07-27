import { Hono } from "hono";
import { z } from "zod";
import { AuthError, type ChallengeService } from "../services/challenge";
import type { SessionIssuer } from "../services/session";
import type { SellerRepository } from "@checkout/core";

const postAuthSchema = z.object({ transaction: z.string().min(1) });

export function authRoutes(deps: {
  challenge: ChallengeService;
  session: SessionIssuer;
  sellers: SellerRepository;
}): Hono {
  const app = new Hono();

  // Step 1 of SEP-10: issue a challenge transaction for the client to sign.
  app.get("/", (ctx) => {
    const account = ctx.req.query("account");
    if (!account) return ctx.json({ error: "missing_account" }, 400);
    try {
      return ctx.json(deps.challenge.build(account));
    } catch (err) {
      if (err instanceof AuthError) return ctx.json({ error: err.message }, 400);
      throw err;
    }
  });

  // Step 2: verify the client-signed challenge and mint a session.
  app.post("/", async (ctx) => {
    const parsed = postAuthSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    let account: string;
    try {
      account = await deps.challenge.verify(parsed.data.transaction);
    } catch (err) {
      if (err instanceof AuthError) return ctx.json({ error: err.message }, 401);
      throw err;
    }

    const seller = await deps.sellers.createIfAbsent(account);
    const token = await deps.session.issue({ sub: account, sellerId: seller.id });
    return ctx.json({ token });
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
