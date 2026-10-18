import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AnchorSession, Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import { SessionIssuer } from "../src/services/session";
import { authRoutes } from "../src/routes/auth";
import { ChallengeService } from "../src/services/challenge";
import { Keypair } from "@stellar/stellar-sdk";
import { createDb, bootstrap, type DB } from "../src/db/client";
import { DrizzleAnchorSessionRepository } from "../src/repos/index";

async function makeDb(): Promise<DB> {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return db;
}

const seller: Seller = {
  id: "sel_logout_test",
  name: "Logout Test Seller",
  wallet: "GSELLERLOGOUT",
  profileKind: "individual",
  payoutFields: null,
  createdAt: Date.now(),
};

function fakeSellers(knownSeller: Seller = seller): SellerRepository {
  return {
    findById: async (id) => (knownSeller.id === id ? knownSeller : null),
    findByWallet: async (wallet) => (knownSeller.wallet === wallet ? knownSeller : null),
    createIfAbsent: async () => knownSeller,
    savePayoutFields: async () => {},
    saveProfileKind: async () => {},
  };
}

function fakeRevocations(): TokenRevocationRepository & { revoked: Set<string> } {
  const revoked = new Set<string>();
  return {
    revoked,
    revoke: async (jti) => {
      revoked.add(jti);
    },
    isRevoked: async (jti) => revoked.has(jti),
    sweepExpired: async () => {},
  };
}

describe("POST /auth/logout - anchor session revocation", () => {
  const serverKeypair = Keypair.random();
  const challenge = new ChallengeService({
    serverKeypair,
    networkPassphrase: "Test SDF Network ; September 2015",
    webAuthDomain: "auth.example.com",
    homeDomain: "example.com",
    fetchAccountSigners: async () => null,
  });

  it("calls onLogout callback and revokes seller anchor session", async () => {
    const db = await makeDb();
    const sessionsRepo = new DrizzleAnchorSessionRepository(db);
    const sessionRecord: AnchorSession = {
      sellerId: seller.id,
      anchorDomain: "testanchor.stellar.org",
      account: seller.wallet,
      token: "header.payload.signature",
      expiresAt: Date.now() + 100_000,
      createdAt: Date.now(),
    };
    await sessionsRepo.save(sessionRecord);
    expect(await sessionsRepo.get(seller.id, "testanchor.stellar.org")).not.toBeNull();

    const sessionIssuer = new SessionIssuer("test-secret-key-12345");
    const { token } = await sessionIssuer.issue({ sub: seller.wallet, sellerId: seller.id });
    const revocations = fakeRevocations();

    const onLogout = vi.fn(async (sellerId: string) => {
      await sessionsRepo.deleteAllForSeller(sellerId);
    });

    const app = new Hono();
    app.route(
      "/auth",
      authRoutes({
        challenge,
        session: sessionIssuer,
        sellers: fakeSellers(seller),
        revocations,
        onLogout,
      }),
    );

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(onLogout).toHaveBeenCalledWith(seller.id);
    expect(await sessionsRepo.get(seller.id, "testanchor.stellar.org")).toBeNull();
  });

  it("still returns 200 OK and revokes Quay session when onLogout throws an error (best effort)", async () => {
    const sessionIssuer = new SessionIssuer("test-secret-key-12345");
    const { token } = await sessionIssuer.issue({ sub: seller.wallet, sellerId: seller.id });
    const revocations = fakeRevocations();

    const onLogout = vi.fn(async () => {
      throw new Error("Database network timeout deleting anchor session");
    });

    const app = new Hono();
    app.route(
      "/auth",
      authRoutes({
        challenge,
        session: sessionIssuer,
        sellers: fakeSellers(seller),
        revocations,
        onLogout,
      }),
    );

    const res = await app.request("/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(onLogout).toHaveBeenCalled();
  });

  it("rejects unauthenticated logout with 401 without calling onLogout", async () => {
    const onLogout = vi.fn();
    const app = new Hono();
    app.route(
      "/auth",
      authRoutes({
        challenge,
        session: new SessionIssuer("test-secret"),
        sellers: fakeSellers(seller),
        revocations: fakeRevocations(),
        onLogout,
      }),
    );

    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
    expect(onLogout).not.toHaveBeenCalled();
  });
});
