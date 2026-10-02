import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import { SessionIssuer } from "../src/services/session";
import { requireSeller, type AuthedVariables } from "../src/middleware/auth";

const seller: Seller = { id: "sel_1", name: "Demo", wallet: "GWALLET", payoutFields: null, createdAt: Date.now() };

function fakeSellers(knownSeller: Seller | null = seller): SellerRepository {
  return {
    findById: async (id) => (knownSeller && knownSeller.id === id ? knownSeller : null),
    findByWallet: async () => knownSeller,
    createIfAbsent: async () => seller,
    savePayoutFields: async () => {},
  };
}

function fakeRevocations(revokedJtis: Set<string> = new Set()): TokenRevocationRepository {
  return {
    revoke: async (jti) => {
      revokedJtis.add(jti);
    },
    isRevoked: async (jti) => revokedJtis.has(jti),
    sweepExpired: async () => {},
  };
}

function buildApp(deps: {
  session: SessionIssuer;
  sellers: SellerRepository;
  revocations: TokenRevocationRepository;
  allowedOrigins?: string[];
}) {
  const app = new Hono<{ Variables: AuthedVariables }>();
  app.use("*", requireSeller(deps));
  app.get("/protected", (ctx) => ctx.json({ sellerId: ctx.get("seller").id, jti: ctx.get("jti") }));
  app.post("/protected", (ctx) => ctx.json({ sellerId: ctx.get("seller").id }));
  return app;
}

describe("requireSeller", () => {
  it("rejects a request with no token — 401", async () => {
    const app = buildApp({ session: new SessionIssuer("s"), sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("unauthorized");
  });

  it("rejects a tampered token — 401", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });
    const tampered = issued.token.slice(0, -2) + "xx";

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token — 401", async () => {
    const session = new SessionIssuer("s", -1);
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token — 401", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });
    const revocations = fakeRevocations(new Set([issued.jti]));

    const app = buildApp({ session, sellers: fakeSellers(), revocations });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).message).toMatch(/revoked/);
  });

  it("rejects a token for a seller that no longer exists — 401", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(null), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(401);
  });

  it("accepts a valid bearer token and exposes seller + jti on context", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { authorization: `Bearer ${issued.token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ sellerId: "sel_1", jti: issued.jti });
  });

  it("also accepts the token via the session cookie (SSR path)", async () => {
    const session = new SessionIssuer("s");
    const issued = await session.issue({ sub: "G1", sellerId: "sel_1" });

    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations() });
    const res = await app.request("/protected", { headers: { cookie: `session=${issued.token}` } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  CSRF. The session cookie is SameSite=None in production — it has to be, or
//  it is never sent at all, since the dashboard and this API are on different
//  registrable domains. SameSite therefore cannot be the defense. Origin is:
//  the browser sets it on every cross-origin request, including a form post,
//  and page JavaScript cannot forge it.
//
//  The asymmetry these tests pin: a bearer token proves intent by existing
//  (something had to choose to attach it), a cookie does not (the browser
//  attaches it for whoever asks).
// ---------------------------------------------------------------------------

describe("requireSeller — CSRF on cookie-authenticated state changes", () => {
  const ALLOWED = ["https://dashboard.example"];

  async function cookieRequest(
    path: string,
    init: RequestInit & { origin?: string } = {},
    allowedOrigins: string[] = ALLOWED,
  ) {
    const session = new SessionIssuer("s");
    const { token } = await session.issue({ sub: "GWALLET", sellerId: "sel_1" });
    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations(), allowedOrigins });
    const headers: Record<string, string> = { cookie: `session=${token}` };
    if (init.origin) headers.origin = init.origin;
    return app.request(path, { ...init, headers });
  }

  it("allows a cookie-only GET with no Origin — reads are not state changes", async () => {
    expect((await cookieRequest("/protected")).status).toBe(200);
  });

  it("rejects a cookie-only POST with no Origin — 403", async () => {
    const res = await cookieRequest("/protected", { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("forbidden");
  });

  it("rejects a cookie-only POST from an origin we never published — the actual CSRF case", async () => {
    const res = await cookieRequest("/protected", { method: "POST", origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("allows a cookie-only POST from an allowed origin", async () => {
    const res = await cookieRequest("/protected", { method: "POST", origin: "https://dashboard.example" });
    expect(res.status).toBe(200);
  });

  it("allows a bearer POST with no Origin at all — a bearer token is its own proof of intent", async () => {
    const session = new SessionIssuer("s");
    const { token } = await session.issue({ sub: "GWALLET", sellerId: "sel_1" });
    const app = buildApp({ session, sellers: fakeSellers(), revocations: fakeRevocations(), allowedOrigins: ALLOWED });
    const res = await app.request("/protected", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a cookie-only POST when no allowlist was configured — fails closed, not open", async () => {
    const res = await cookieRequest("/protected", { method: "POST", origin: "https://dashboard.example" }, []);
    expect(res.status).toBe(403);
  });
});
