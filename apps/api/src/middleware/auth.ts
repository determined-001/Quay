import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import type { SessionIssuer } from "../services/session";
import type { RequestContextVariables } from "../request-context";
import type { ApiKey, DrizzleApiKeyRepository } from "../repos/index";
import { ALL_SCOPES, KEY_PREFIX_LEN, verifyApiKey, type ApiKeyScope } from "../services/api-keys";
import { clientIp } from "./rate-limit";

export const SESSION_COOKIE = "session";

// Extends RequestContextVariables — `requestContext` middleware is installed
// ahead of `requireSeller` on every route (see index.ts), so requestId/logger
// are always present by the time a route handler runs.
export interface AuthedVariables extends RequestContextVariables {
  seller: Seller;
  jti: string;
  /** epoch seconds — the verified token's own `exp`, handed to routes (e.g.
   *  logout) that need it without re-decoding the raw token themselves. */
  sessionExp: number;
}

/**
 * Resolves `Authorization: Bearer <token>` (or the httpOnly `session` cookie,
 * for SSR requests that can't hold the token in JS memory) into an
 * authenticated `Seller`, bound onto the request context as `ctx.get("seller")`.
 *
 * 401 vs 403: this middleware only ever produces 401 (`unauthorized`) — no
 * token, or one that's malformed, expired, tampered, or revoked. 403
 * (`forbidden`) is a route-level concern for an authenticated seller acting on
 * a resource that isn't theirs (see `links.ts`'s ownership check) — a
 * different failure mode from "who even are you."
 */
export function requireSeller(deps: {
  session: SessionIssuer;
  sellers: SellerRepository;
  revocations: TokenRevocationRepository;
}): MiddlewareHandler<{ Variables: AuthedVariables }> {
  return async (ctx: Context<{ Variables: AuthedVariables }>, next: Next) => {
    const header = ctx.req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? getCookie(ctx, SESSION_COOKIE);

    if (!token) {
      return ctx.json({ error: "unauthorized", message: "missing session token" }, 401);
    }

    let payload;
    try {
      payload = await deps.session.verify(token);
    } catch {
      return ctx.json({ error: "unauthorized", message: "invalid, tampered, or expired session token" }, 401);
    }

    if (await deps.revocations.isRevoked(payload.jti)) {
      return ctx.json({ error: "unauthorized", message: "session has been revoked" }, 401);
    }

    const seller = await deps.sellers.findById(payload.sellerId);
    if (!seller) {
      return ctx.json({ error: "unauthorized", message: "seller no longer exists" }, 401);
    }

    ctx.set("seller", seller);
    ctx.set("jti", payload.jti);
    ctx.set("sessionExp", payload.exp);
    await next();
  };
}

// ── API keys (issue #40, 6.3) ─────────────────────────────────────────────

/**
 * Variables set by `buildAuthMiddleware` on every authenticated request.
 * Extends RequestContextVariables (requestId/logger — `requestContext` is
 * installed ahead of this middleware in index.ts, same as AuthedVariables)
 * with the scope set the request is authorized for: the key's own scopes on
 * the API-key path, or ALL_SCOPES on the session path.
 */
export interface AuthVariables extends RequestContextVariables {
  seller: Seller;
  /** Scopes granted to this request — the key's scopes, or ALL_SCOPES for a
   *  session (a logged-in seller is the root user of their own account). */
  scopes: ApiKeyScope[];
  authKind: "api_key" | "session";
  /** Session-only (set by requireSeller); undefined on the API-key path. */
  jti?: string;
  sessionExp?: number;
}

export interface AuthDeps {
  session: SessionIssuer;
  sellers: SellerRepository;
  revocations: TokenRevocationRepository;
  apiKeyRepo: DrizzleApiKeyRepository;
}

/** Return true when the token is one of ours (`ak_live_…` / `ak_test_…`). */
function looksLikeApiKey(value: string): boolean {
  return value.startsWith("ak_live_") || value.startsWith("ak_test_");
}

/**
 * Verify a raw key against the store. Fast pre-filter on the lookup prefix
 * (indexed, cheap) before the scrypt round-trip; then constant-time verify
 * against every active candidate sharing that prefix.
 */
async function resolveApiKey(raw: string, repo: DrizzleApiKeyRepository): Promise<ApiKey | null> {
  const prefix = raw.slice(0, KEY_PREFIX_LEN);
  const candidates = await repo.findAllActiveByPrefix(prefix);
  for (const candidate of candidates) {
    if (await verifyApiKey(raw, candidate.hash)) return candidate;
  }
  return null;
}

/**
 * Composed auth middleware. Mount it anywhere a seller context is needed.
 *
 *   Authorization: Bearer ak_live_… / ak_test_…  → API-key path, scopes from the key
 *   Authorization: Bearer <session JWT>, or the session cookie → requireSeller (#79), ALL_SCOPES
 *   neither                                        → 401
 *
 * The two schemes resolve to the same seller context (`ctx.get("seller")`) so
 * route handlers stay auth-agnostic (issue #40 item 6). There is deliberately
 * no unauthenticated fallback: a request with no credentials is rejected, never
 * silently promoted to the default seller.
 */
export function buildAuthMiddleware(deps: AuthDeps): MiddlewareHandler<{ Variables: AuthVariables }> {
  const sessionGuard = requireSeller(deps);

  return async (ctx, next) => {
    const header = ctx.req.header("authorization");
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    const token = bearer ?? getCookie(ctx, SESSION_COOKIE);

    if (token && looksLikeApiKey(token)) {
      // ── API-key path ───────────────────────────────────────────────────
      const matched = await resolveApiKey(token, deps.apiKeyRepo);
      if (!matched) return ctx.json({ error: "invalid_api_key" }, 401);

      const seller = await deps.sellers.findById(matched.sellerId);
      if (!seller) {
        // Key exists but the seller row vanished — treat as invalid.
        return ctx.json({ error: "invalid_api_key" }, 401);
      }

      ctx.set("seller", seller);
      ctx.set("scopes", matched.scopes);
      ctx.set("authKind", "api_key");

      // Fire-and-forget last_used_at update (issue spec: "asynchronously").
      // Swallow failures — a DB blip must never take the process down via an
      // unhandled rejection on the hot path.
      void deps.apiKeyRepo.touchLastUsed(matched.id).catch(() => {});

      return next();
    }

    // ── Session path ────────────────────────────────────────────────────
    // Delegate to #79's requireSeller. We run it with a no-op next so we can
    // grant ALL_SCOPES only after it has authenticated; on failure it has
    // already produced the 401 response, which we hand straight back.
    const unauthorized = await sessionGuard(
      ctx as unknown as Context<{ Variables: AuthedVariables }>,
      async () => {},
    );
    if (unauthorized) return unauthorized;

    ctx.set("scopes", [...ALL_SCOPES] as ApiKeyScope[]);
    ctx.set("authKind", "session");
    return next();
  };
}

/**
 * Route-level scope guard. Place after the auth middleware:
 *
 *   app.post("/:id/cash-out", requireScope("offramp:initiate"), handler)
 *
 * Returns 403 `{ error: "missing_scope", required: "<scope>" }` when the
 * authenticated context does not include the required scope.
 */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (ctx, next) => {
    const scopes = ctx.get("scopes");
    if (!scopes || !scopes.includes(scope)) {
      return ctx.json({ error: "missing_scope", required: scope }, 403);
    }
    return next();
  };
}

/**
 * Rate-limit key that is per-API-key for `Bearer ak_…` callers (bucketed by the
 * key's lookup prefix — issue #40 item 4) and per-client-IP for everyone else.
 * Mount via `rateLimit({ keyFor: apiKeyRateLimitKey })` on routes a key can hit.
 */
export function apiKeyRateLimitKey(ctx: Context, trustProxyHops: number): string {
  const header = ctx.req.header("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && looksLikeApiKey(bearer)) return `api-key:${bearer.slice(0, KEY_PREFIX_LEN)}`;
  return `ip:${clientIp(ctx, trustProxyHops)}`;
}
