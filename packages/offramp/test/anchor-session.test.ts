import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, Transaction, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { AnchorAuthRequiredError, OffRampJobNotFoundError, type AnchorCustomer } from "@checkout/core";
import { AnchorChallengeError, AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { TestAnchorKyc } from "../src/kyc";
import { TestAnchorOffRamp } from "../src/testanchor";
import { clearStellarTomlCache } from "../src/sep1";
import { clearSep6InfoCache } from "../src/sep6";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// ---------------------------------------------------------------------------
// Each seller is their own customer at the anchor. These drive a stub anchor
// that behaves like a real one — it keys everything by the SEP-10 account —
// and check that no seller's session, KYC record or withdrawal can end up
// under another seller's account.
// ---------------------------------------------------------------------------

const HOME = "anchor.example";
const ORIGIN = `https://${HOME}`;
const USDC = { code: "USDC", issuer: Keypair.random().publicKey() };
const anchorKey = Keypair.random();

const alice = Keypair.random();
const bob = Keypair.random();
const ALICE: AnchorCustomer = { sellerId: "sel_alice", account: alice.publicKey() };
const BOB: AnchorCustomer = { sellerId: "sel_bob", account: bob.publicKey() };

const TOML = `
NETWORK_PASSPHRASE="${Networks.TESTNET}"
SIGNING_KEY="${anchorKey.publicKey()}"
WEB_AUTH_ENDPOINT="${ORIGIN}/auth"
TRANSFER_SERVER="${ORIGIN}/sep6"
KYC_SERVER="${ORIGIN}/sep12"
ANCHOR_QUOTE_SERVER="${ORIGIN}/sep38"
[[CURRENCIES]]
code="USDC"
`;

function jwtFor(sub: string): string {
  const claims = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return ["h", claims, "s"].join(".");
}

function subOf(req: { headers?: HeadersInit }): string {
  const auth = new Headers(req.headers).get("authorization") ?? "";
  const claims = JSON.parse(Buffer.from(auth.replace("Bearer ", "").split(".")[1]!, "base64url").toString("utf8"));
  return claims.sub as string;
}

/** A stub anchor keyed by SEP-10 account, the way real anchors key customers. */
function stubAnchor(opts: { signingKey?: Keypair; tokenSub?: (account: string) => string } = {}) {
  const customers = new Map<string, { id: string; fields: Record<string, string> }>();
  const withdrawals: Array<{ account: string; sub: string }> = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/stellar.toml") return new Response(TOML);
    if (url.pathname === "/auth" && init?.method === "POST") {
      const xdr = JSON.parse(init.body as string).transaction as string;
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
      const account = tx.operations[0]!.source as string;
      return Response.json({ token: jwtFor(opts.tokenSub ? opts.tokenSub(account) : account) });
    }
    if (url.pathname === "/auth") {
      const tx = WebAuth.buildChallengeTx(
        opts.signingKey ?? anchorKey,
        url.searchParams.get("account")!,
        HOME,
        300,
        Networks.TESTNET,
        HOME,
      );
      return Response.json({ transaction: tx, network_passphrase: Networks.TESTNET });
    }
    if (url.pathname === "/sep12/customer" && init?.method === "PUT") {
      const sub = subOf(init);
      const body = JSON.parse(init.body as string) as Record<string, string>;
      const { account: _a, id: _i, ...fields } = body;
      const c = customers.get(sub) ?? { id: `cus_${customers.size + 1}`, fields: {} };
      customers.set(sub, { id: c.id, fields: { ...c.fields, ...fields } });
      return Response.json({ id: c.id });
    }
    if (url.pathname === "/sep12/customer") {
      const sub = subOf(init ?? {});
      const c = customers.get(sub);
      const id = url.searchParams.get("id");
      // A real anchor never hands one account's customer to another's JWT.
      if (!c || (id && id !== c.id)) return new Response("not found", { status: 404 });
      return Response.json({ id: c.id, status: "ACCEPTED" });
    }
    if (url.pathname === "/sep6/info") {
      return Response.json({
        withdraw: { USDC: { enabled: true, types: { bank_account: { fields: {} } } } },
      });
    }
    if (url.pathname === "/sep38/quote") {
      return Response.json({
        id: "q_1",
        price: "0.001",
        buy_amount: "9900",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    if (url.pathname === "/sep6/withdraw") {
      withdrawals.push({ account: url.searchParams.get("account")!, sub: subOf(init ?? {}) });
      return Response.json({ id: "wd_1", account_id: anchorKey.publicKey(), memo_type: "id", memo: "4242" });
    }
    if (url.pathname === "/sep6/transaction") {
      return Response.json({ transaction: { id: url.searchParams.get("id"), status: "pending_user_transfer_start" } });
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { customers, withdrawals };
}

function setup() {
  const discovery = new AnchorDiscovery({ homeDomain: HOME, fallbackBaseUrl: ORIGIN });
  const sessions = new FakeAnchorSessionRepository();
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
  return { discovery, sessions, auth };
}

/** What the dashboard does: fetch the challenge, have the wallet sign it, post it back. */
async function signIn(auth: SellerAnchorAuth, customer: AnchorCustomer, wallet: Keypair): Promise<void> {
  const { transaction } = await auth.challenge(customer);
  const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
  tx.sign(wallet);
  await auth.complete(customer, tx.toXDR());
}

beforeEach(() => {
  clearStellarTomlCache();
  clearSep6InfoCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("SellerAnchorAuth", () => {
  it("has no token for a seller who never signed in — only their wallet can fix that", async () => {
    stubAnchor();
    const { auth } = setup();
    await expect(auth.token(ALICE)).rejects.toBeInstanceOf(AnchorAuthRequiredError);
  });

  it("keeps a separate session per seller, each for that seller's own account", async () => {
    stubAnchor();
    const { auth, sessions } = setup();
    await signIn(auth, ALICE, alice);
    await signIn(auth, BOB, bob);

    expect((await sessions.get(ALICE.sellerId, HOME))?.account).toBe(alice.publicKey());
    expect((await sessions.get(BOB.sellerId, HOME))?.account).toBe(bob.publicKey());
    expect(await auth.token(ALICE)).not.toBe(await auth.token(BOB));
  });

  it("refuses a challenge not signed by the anchor's published SIGNING_KEY", async () => {
    stubAnchor({ signingKey: Keypair.random() });
    const { auth } = setup();
    await expect(auth.challenge(ALICE)).rejects.toBeInstanceOf(AnchorChallengeError);
  });

  it("refuses a signed challenge for a different account than the signed-in seller", async () => {
    stubAnchor();
    const { auth } = setup();
    const { transaction } = await auth.challenge(BOB);
    const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
    tx.sign(bob);
    // Alice posting Bob's signed challenge must not become Alice's session.
    await expect(auth.complete(ALICE, tx.toXDR())).rejects.toBeInstanceOf(AnchorChallengeError);
  });

  it("refuses to store a token the anchor issued to another account", async () => {
    stubAnchor({ tokenSub: () => bob.publicKey() });
    const { auth } = setup();
    await expect(signIn(auth, ALICE, alice)).rejects.toThrow(/different account/);
  });

  it("treats a session for the seller's previous wallet as no session", async () => {
    stubAnchor();
    const { auth } = setup();
    await signIn(auth, ALICE, alice);
    const newWallet = { ...ALICE, account: Keypair.random().publicKey() };
    await expect(auth.token(newWallet)).rejects.toBeInstanceOf(AnchorAuthRequiredError);
  });
});

describe("TestAnchorKyc — per seller", () => {
  it("submits each seller's identity under their own account, never overwriting another's", async () => {
    const anchor = stubAnchor();
    const { discovery, auth } = setup();
    const repo = new InMemoryKycRepo();
    const kyc = new TestAnchorKyc({ discovery, auth, repo });
    await signIn(auth, ALICE, alice);
    await signIn(auth, BOB, bob);

    await kyc.submit(ALICE, { first_name: "Alice" });
    await kyc.submit(BOB, { first_name: "Bob" });

    expect(anchor.customers.get(alice.publicKey())?.fields.first_name).toBe("Alice");
    expect(anchor.customers.get(bob.publicKey())?.fields.first_name).toBe("Bob");
  });

  it("does not reuse a customer id recorded under the old shared platform account", async () => {
    stubAnchor();
    const { discovery, auth } = setup();
    const repo = new InMemoryKycRepo();
    // A row from before per-seller identity: no account, somebody else's customer.
    await repo.save({
      sellerId: ALICE.sellerId,
      account: null,
      customerId: "cus_platform",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: { first_name: "Alice" },
      message: null,
      lastSyncedAt: null,
      updatedAt: 0,
    });
    const kyc = new TestAnchorKyc({ discovery, auth, repo });
    await signIn(auth, ALICE, alice);

    // Looked up by Alice's own account: the anchor has never seen her, so she
    // is not ACCEPTED on the strength of the platform's record.
    const record = await kyc.status(ALICE);
    expect(record.status).toBe("unsubmitted");
    expect(record.account).toBe(alice.publicKey());
    // What she had on file is still there to resubmit — the reusable profile.
    expect(record.providedFields.first_name).toBe("Alice");
  });
});

describe("TestAnchorOffRamp — per seller", () => {
  it("withdraws as the seller and returns the transfer for their wallet to sign", async () => {
    const anchor = stubAnchor();
    const { discovery, auth } = setup();
    const state = new FakeOffRampStateRepository();
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });
    await signIn(auth, ALICE, alice);

    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: USDC,
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: ALICE,
    });
    const initiation = await offramp.initiate({
      linkId: "lnk_1",
      quoteId: quote.quoteId,
      payout: { currency: "NGN", fields: { dest: "0123456789" } },
      customer: ALICE,
    });

    expect(anchor.withdrawals).toEqual([{ account: alice.publicKey(), sub: alice.publicKey() }]);
    expect(initiation).toEqual({
      kind: "transfer",
      jobId: "wd_1",
      transfer: { destination: anchorKey.publicKey(), amount: "10", asset: USDC, memo: "4242", memoType: "id" },
    });
    expect(await state.getJob("wd_1")).toMatchObject({ sellerId: ALICE.sellerId, account: alice.publicKey() });

    const polled = await offramp.status("wd_1");
    expect(polled.status).toBe("pending");
  });

  it("will not quote for a seller with no anchor session", async () => {
    stubAnchor();
    const { discovery, auth } = setup();
    const offramp = new TestAnchorOffRamp({ discovery, auth, state: new FakeOffRampStateRepository() });
    await expect(
      offramp.quote({ linkId: "lnk_1", sourceAsset: USDC, sourceAmount: "10", targetCurrency: "NGN", customer: ALICE }),
    ).rejects.toBeInstanceOf(AnchorAuthRequiredError);
  });

  it("treats a job from the shared-platform-account era as unreachable", async () => {
    stubAnchor();
    const { discovery, auth } = setup();
    const state = new FakeOffRampStateRepository();
    await state.saveJob({
      jobId: "wd_old",
      linkId: "lnk_1",
      anchor: HOME,
      sellerId: null,
      account: null,
      targetCurrency: "NGN",
      targetAmount: "",
      rate: "1",
      status: "pending",
      externalStatus: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    });
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });
    await expect(offramp.status("wd_old")).rejects.toBeInstanceOf(OffRampJobNotFoundError);
  });
});

class InMemoryKycRepo {
  private readonly rows = new Map<string, import("@checkout/core").KycRecord>();
  async get(sellerId: string) {
    return this.rows.get(sellerId) ?? null;
  }
  async save(record: import("@checkout/core").KycRecord) {
    this.rows.set(record.sellerId, record);
  }
}
