import type { Context, Next } from "hono";
import type { ApiKeyRepository } from "@checkout/core";
import { hashApiKey } from "../services/api-keys";

export type AuthVariables = { sellerId: string };

export interface Auth {
  /** Soft check: `null` on missing/invalid credentials, never throws or writes a response - callers decide what "no seller" means for their route (401 for a protected route, "fall through to the public view" for the checkout read). */
  resolveSellerId(authHeader: string | undefined): Promise<string | null>;
  /** Hard gate: a Hono middleware that 401s if `resolveSellerId` comes back null, otherwise sets `sellerId` on the request context. */
  requireAuth(ctx: Context<{ Variables: AuthVariables }>, next: Next): Promise<Response | void>;
}

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) return undefined;
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/** Real API-key auth (issue 6.4). Looks up the key's hash - the raw key is never stored, only ever seen at mint time. */
export function makeAuth(deps: { apiKeys: ApiKeyRepository }): Auth {
  async function resolveSellerId(authHeader: string | undefined): Promise<string | null> {
    const token = bearerToken(authHeader);
    if (!token) return null;
    const key = await deps.apiKeys.findByHash(hashApiKey(token));
    return key?.sellerId ?? null;
  }

  return {
    resolveSellerId,
    async requireAuth(ctx, next) {
      const sellerId = await resolveSellerId(ctx.req.header("authorization"));
      if (!sellerId) return ctx.json({ error: "unauthorized" }, 401);
      ctx.set("sellerId", sellerId);
      return next();
    },
  };
}

/**
 * `SINGLE_TENANT_DEV=1` - every request is treated as the one seeded seller,
 * no credential needed. This exists purely so local dev (and a solo/demo
 * deployment that's genuinely single-tenant) doesn't need a key-management
 * flow that issue 6.1/6.2's real wallet-login UX hasn't shipped yet. It is
 * hard-refused outside dev - see `env.ts`'s startup guard, which throws
 * before this function is ever called if `NODE_ENV=production`. This
 * function does not re-check that itself; it trusts the caller already
 * enforced it, so it stays a pure "who's asking" resolver.
 */
export function makeSingleTenantDevAuth(getDefaultSellerId: () => string): Auth {
  return {
    async resolveSellerId() {
      return getDefaultSellerId();
    },
    async requireAuth(ctx, next) {
      ctx.set("sellerId", getDefaultSellerId());
      return next();
    },
  };
}
