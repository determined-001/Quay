import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Seller, SellerRepository, TokenRevocationRepository } from "@checkout/core";
import { authRoutes } from "../src/routes/auth";
import { ChallengeService } from "../src/services/challenge";
import { SignerLookupUnavailableError } from "../src/services/horizon-signers";
import { SessionIssuer } from "../src/services/session";
import type { AuthedVariables } from "../src/middleware/auth";

const defaultSeller: Seller = {
  id: "sel_default",
  name: "Default Test Seller",
  wallet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  profileKind: "individual",
  payoutFields: null,
  createdAt: Date.now(),
};

function fakeSellers(initialSeller: Seller = defaultSeller): SellerRepository & { created: Seller[]; touched: string[] } {
  const created: Seller[] = [];
  const touched: string[] = [];
  const map = new Map<string, Seller>();
  map.set(initialSeller.wallet, initialSeller);
  map.set(initialSeller.id, initialSeller);

  return {
    created,
    touched,
    findById: async (id) => map.get(id) ?? null,
    findByWallet: async (wallet) => map.get(wallet) ?? null,
    createIfAbsent: async (wallet) => {
      const found = map.get(wallet);
      if (found) return found;
      const createdSeller: Seller = {
        id: `sel_${wallet.slice(0, 8)}`,
        name: "Test Seller",
        wallet,
        profileKind: "individual",
        payoutFields: null,
        createdAt: Date.now(),
      };
      map.set(wallet, createdSeller);
      map.set(createdSeller.id, createdSeller);
      created.push(createdSeller);
      return createdSeller;
    },
    touchLastActive: async (id) => {
      touched.push(id);
    },
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

function buildAuthApp(overrides?: {
  fetchAccountSigners?: (accountId: string) => Promise<any>;
  secureCookie?: boolean;
  sellers?: SellerRepository;
  revocations?: TokenRevocationRepository;
  session?: SessionIssuer;
  serverKeypair?: Keypair;
}) {
  const serverKeypair = overrides?.serverKeypair ?? Keypair.random();
  const session = overrides?.session ?? new SessionIssuer("test-jwt-secret-for-auth-tests");
  const sellers = overrides?.sellers ?? fakeSellers();
  const revocations = overrides?.revocations ?? fakeRevocations();
  const challenge = new ChallengeService({
    serverKeypair,
    homeDomain: "example.com",
    webAuthDomain: "auth.example.com",
    networkPassphrase: Networks.TESTNET,
    fetchAccountSigners: overrides?.fetchAccountSigners ?? (async () => null),
  });

  const app = new Hono<{ Variables: AuthedVariables }>();
  app.route(
    "/auth",
    authRoutes({
      challenge,
      session,
      sellers,
      revocations,
      secureCookie: overrides?.secureCookie,
    }),
  );

  return { app, serverKeypair, session, sellers, revocations, challenge };
}

function createSignedChallenge(serverKeypair: Keypair, clientKeypair: Keypair): string {
  const service = new ChallengeService({
    serverKeypair,
    homeDomain: "example.com",
    webAuthDomain: "auth.example.com",
    networkPassphrase: Networks.TESTNET,
    fetchAccountSigners: async () => null,
  });
  const { transaction, network_passphrase } = service.build(clientKeypair.publicKey());
  const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
  tx.sign(clientKeypair);
  return tx.toXDR();
}

describe("GET /auth (SEP-10 challenge issuance)", () => {
  it("returns 400 missing_account when account query parameter is absent", async () => {
    const { app } = buildAuthApp();
    const res = await app.request("/auth");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("missing_account");
  });

  it("returns 400 when account is not a valid Stellar G-address", async () => {
    const { app } = buildAuthApp();
    const res = await app.request("/auth?account=not-a-valid-account");
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("account must be a valid Stellar G-address");
  });

  it("returns 200 with challenge transaction for a valid G-address", async () => {
    const { app } = buildAuthApp();
    const client = Keypair.random();
    const res = await app.request(`/auth?account=${client.publicKey()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transaction: string; network_passphrase: string };
    expect(body.transaction).toBeDefined();
    expect(typeof body.transaction).toBe("string");
    expect(body.network_passphrase).toBe(Networks.TESTNET);
  });
});

describe("POST /auth (SEP-10 challenge verification & session minting)", () => {
  it("returns 400 invalid_body when request body is empty or malformed", async () => {
    const { app } = buildAuthApp();

    const emptyRes = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptyRes.status).toBe(400);
    expect(((await emptyRes.json()) as Record<string, unknown>).error).toBe("invalid_body");

    const nonJsonRes = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "invalid-json",
    });
    expect(nonJsonRes.status).toBe(400);
    expect(((await nonJsonRes.json()) as Record<string, unknown>).error).toBe("invalid_body");

    const emptyTxRes = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: "" }),
    });
    expect(emptyTxRes.status).toBe(400);
    expect(((await emptyTxRes.json()) as Record<string, unknown>).error).toBe("invalid_body");
  });

  it("returns 401 when verification throws AuthError (e.g. unsigned or tampered challenge)", async () => {
    const { app, serverKeypair } = buildAuthApp();
    const client = Keypair.random();

    // Challenge built by server but NOT signed by the client
    const service = new ChallengeService({
      serverKeypair,
      homeDomain: "example.com",
      webAuthDomain: "auth.example.com",
      networkPassphrase: Networks.TESTNET,
      fetchAccountSigners: async () => null,
    });
    const { transaction } = service.build(client.publicKey());

    const res = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  it("returns 503 horizon_unavailable when signer lookup is unavailable", async () => {
    const { app, serverKeypair } = buildAuthApp({
      fetchAccountSigners: async () => {
        throw new SignerLookupUnavailableError(new Error("Network failure reaching Horizon"));
      },
    });
    const client = Keypair.random();
    const transaction = createSignedChallenge(serverKeypair, client);

    const res = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("horizon_unavailable");
  });

  it("sets Set-Cookie with HttpOnly, Secure, and SameSite=None in secure mode (default)", async () => {
    const { app, serverKeypair, sellers } = buildAuthApp(); // default secureCookie: true
    const client = Keypair.random();
    const transaction = createSignedChallenge(serverKeypair, client);

    const res = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: number };
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe("string");
    expect(typeof body.expiresAt).toBe("number");

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`session=${body.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Path=/");

    // Verify seller was created and touched
    const seller = await sellers.findByWallet(client.publicKey());
    expect(seller).not.toBeNull();
  });

  it("sets Set-Cookie with HttpOnly and SameSite=Lax without Secure in non-secure mode", async () => {
    const { app, serverKeypair } = buildAuthApp({ secureCookie: false });
    const client = Keypair.random();
    const transaction = createSignedChallenge(serverKeypair, client);

    const res = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction }),
    });
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("Path=/");
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie and revokes the session so the same token gets 401", async () => {
    const sellers = fakeSellers();
    const revocations = fakeRevocations();
    const session = new SessionIssuer("test-jwt-secret-for-auth-tests");

    const seller = await sellers.createIfAbsent(Keypair.random().publicKey());
    const { token } = await session.issue({ sub: seller.wallet, sellerId: seller.id });

    const { app } = buildAuthApp({ sellers, revocations, session });

    // Calling POST /auth/logout with the valid session token
    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logoutRes.status).toBe(200);
    expect(await logoutRes.json()).toEqual({ ok: true });

    // Cookie is cleared (Max-Age=0)
    const logoutCookie = logoutRes.headers.get("set-cookie") ?? "";
    expect(logoutCookie).toContain("session=");
    expect(logoutCookie).toMatch(/Max-Age=0|expires=/i);

    // Using the same token again after logout must be rejected with 401
    const postLogoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(postLogoutRes.status).toBe(401);
    const body = (await postLogoutRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
  });
});
