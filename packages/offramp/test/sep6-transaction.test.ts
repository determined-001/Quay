import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, Transaction, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import type { AnchorCustomer } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { clearStellarTomlCache } from "../src/sep1";
import { clearSep6InfoCache, getSep6Transaction, Sep6TransactionError } from "../src/sep6";
import { TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// SEP-6 lets an anchor omit `account_id` from /withdraw and publish the deposit
// instructions on GET /transaction once it reaches `pending_user_transfer_start`
// (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md).
// Nothing here talks to a real anchor: the stub below returns exactly the
// documented fields, so it proves Quay reads them, not how any one anchor behaves.

const HOME = "anchor.example";
const ORIGIN = `https://${HOME}`;
const USDC = { code: "USDC", issuer: Keypair.random().publicKey() };
const anchorKey = Keypair.random();
const ANCHOR_DEPOSIT_ACCOUNT = Keypair.random().publicKey();
const seller = Keypair.random();
const SELLER: AnchorCustomer = { sellerId: "sel_1", account: seller.publicKey() };

const TOML = `
NETWORK_PASSPHRASE="${Networks.TESTNET}"
SIGNING_KEY="${anchorKey.publicKey()}"
WEB_AUTH_ENDPOINT="${ORIGIN}/auth"
TRANSFER_SERVER="${ORIGIN}/sep6"
ANCHOR_QUOTE_SERVER="${ORIGIN}/sep38"
[[CURRENCIES]]
code="USDC"
`;

function jwtFor(sub: string): string {
  // iss/iat are checked by SellerAnchorAuth before it stores a session.
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = Buffer.from(
    JSON.stringify({ iss: `${ORIGIN}/auth`, sub, iat: nowSec, exp: nowSec + 3600 }),
  ).toString("base64url");
  return ["h", claims, "s"].join(".");
}

/** What GET /transaction returns; swapped per test to move the anchor along. */
let transactionBody: Record<string, unknown>;

function stubAnchor(opts: { withdrawBody?: Record<string, unknown> } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/stellar.toml") return new Response(TOML);
      if (url.pathname === "/auth" && init?.method === "POST") {
        const tx = TransactionBuilder.fromXDR(JSON.parse(init.body as string).transaction, Networks.TESTNET) as Transaction;
        return Response.json({ token: jwtFor(tx.operations[0]!.source as string) });
      }
      if (url.pathname === "/auth") {
        const tx = WebAuth.buildChallengeTx(anchorKey, url.searchParams.get("account")!, HOME, 300, Networks.TESTNET, HOME);
        return Response.json({ transaction: tx, network_passphrase: Networks.TESTNET });
      }
      if (url.pathname === "/sep6/info") {
        return Response.json({ withdraw: { USDC: { enabled: true, types: { bank_account: { fields: {} } } } } });
      }
      if (url.pathname === "/sep38/quote") {
        return Response.json({
          id: "q_1",
          price: "0.001",
          buy_amount: "9900",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      // The anchor has not finished its own checks: no account_id yet.
      if (url.pathname === "/sep6/withdraw") return Response.json(opts.withdrawBody ?? { id: "wd_1" });
      if (url.pathname === "/sep6/transaction") return Response.json({ transaction: transactionBody });
      return new Response("unexpected", { status: 500 });
    }),
  );
}

function setup(state = new FakeOffRampStateRepository()) {
  const discovery = new AnchorDiscovery({ homeDomain: HOME, fallbackBaseUrl: ORIGIN });
  const auth = new SellerAnchorAuth({
    discovery,
    sessions: new FakeAnchorSessionRepository(),
    networkPassphrase: Networks.TESTNET,
  });
  return { discovery, auth, state };
}

async function signIn(auth: SellerAnchorAuth): Promise<void> {
  const { transaction } = await auth.challenge(SELLER);
  const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
  tx.sign(seller);
  await auth.complete(SELLER, tx.toXDR());
}

async function startWithdrawal(offramp: TestAnchorOffRamp) {
  const quote = await offramp.quote({
    linkId: "lnk_1",
    sourceAsset: USDC,
    sourceAmount: "10",
    targetCurrency: "NGN",
    customer: SELLER,
  });
  return offramp.initiate({
    linkId: "lnk_1",
    quoteId: quote.quoteId,
    payout: { currency: "NGN", fields: { dest: "0123456789" } },
    customer: SELLER,
  });
}

beforeEach(() => {
  clearStellarTomlCache();
  clearSep6InfoCache();
  transactionBody = { id: "wd_1", status: "pending_anchor" };
});
afterEach(() => vi.unstubAllGlobals());

describe("getSep6Transaction — deposit instructions", () => {
  it("reads withdraw_anchor_account, memo, memo type and amount_in at pending_user_transfer_start", async () => {
    stubAnchor();
    transactionBody = {
      id: "wd_1",
      status: "pending_user_transfer_start",
      withdraw_anchor_account: ANCHOR_DEPOSIT_ACCOUNT,
      withdraw_memo: "4242",
      withdraw_memo_type: "id",
      amount_in: "10.5",
    };
    const tx = await getSep6Transaction(ORIGIN + "/sep6", "jwt", "wd_1");
    expect(tx).toMatchObject({
      status: "pending_user_transfer_start",
      withdrawAnchorAccount: ANCHOR_DEPOSIT_ACCOUNT,
      withdrawMemo: "4242",
      withdrawMemoType: "id",
      amountIn: "10.5",
    });
  });

  it("rejects an unknown withdraw_memo_type instead of guessing one", async () => {
    stubAnchor();
    transactionBody = {
      id: "wd_1",
      status: "pending_user_transfer_start",
      withdraw_anchor_account: ANCHOR_DEPOSIT_ACCOUNT,
      withdraw_memo: "abc",
      withdraw_memo_type: "return",
    };
    await expect(getSep6Transaction(ORIGIN + "/sep6", "jwt", "wd_1")).rejects.toBeInstanceOf(Sep6TransactionError);
  });

  it("ignores instructions at other statuses, so a stray value cannot wedge a finished job", async () => {
    stubAnchor();
    transactionBody = {
      id: "wd_1",
      status: "completed",
      withdraw_anchor_account: ANCHOR_DEPOSIT_ACCOUNT,
      withdraw_memo_type: "bogus",
    };
    const tx = await getSep6Transaction(ORIGIN + "/sep6", "jwt", "wd_1");
    expect(tx.withdrawAnchorAccount).toBeUndefined();
    expect(tx.withdrawMemoType).toBeUndefined();
  });
});

describe("TestAnchorOffRamp.status() — instructions that arrive after /withdraw", () => {
  it("returns and persists the exact destination, memo and memo type once the anchor publishes them", async () => {
    stubAnchor();
    const { discovery, auth, state } = setup();
    await signIn(auth);
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });

    // /withdraw had no account_id.
    expect(await startWithdrawal(offramp)).toEqual({ kind: "fields", jobId: "wd_1" });

    // Still reviewing: nothing to relay.
    const early = await offramp.status("wd_1");
    expect(early.status).toBe("pending");
    expect(early.transfer).toBeUndefined();

    transactionBody = {
      id: "wd_1",
      status: "pending_user_transfer_start",
      withdraw_anchor_account: ANCHOR_DEPOSIT_ACCOUNT,
      withdraw_memo: "4242",
      withdraw_memo_type: "id",
    };
    const job = await offramp.status("wd_1");
    expect(job.status).toBe("awaiting_transfer");
    // No amount_in: falls back to the quoted sell amount, in the quoted asset.
    expect(job.transfer).toEqual({
      destination: ANCHOR_DEPOSIT_ACCOUNT,
      amount: "10",
      asset: USDC,
      memo: "4242",
      memoType: "id",
    });

    // Survives a restart: a fresh adapter sharing only the persisted state.
    const persisted = await state.getJob("wd_1");
    expect(persisted?.transfer).toEqual(job.transfer);
    // The seller's anchor session is persisted separately (anchor_sessions), so `auth` stands in for it.
    const afterRestart = new TestAnchorOffRamp({ discovery, auth, state });
    expect((await afterRestart.status("wd_1")).transfer).toEqual(job.transfer);
  });

  it("prefers the anchor's amount_in over the quoted amount", async () => {
    stubAnchor();
    const { discovery, auth, state } = setup();
    await signIn(auth);
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });
    await startWithdrawal(offramp);

    transactionBody = {
      id: "wd_1",
      status: "pending_user_transfer_start",
      withdraw_anchor_account: ANCHOR_DEPOSIT_ACCOUNT,
      amount_in: "10.25",
    };
    const job = await offramp.status("wd_1");
    expect(job.transfer).toMatchObject({ amount: "10.25", memo: null, memoType: null });
  });

  it("does not report a transfer when the status is pending_user_transfer_start but no account was published", async () => {
    stubAnchor();
    const { discovery, auth, state } = setup();
    await signIn(auth);
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });
    await startWithdrawal(offramp);

    transactionBody = { id: "wd_1", status: "pending_user_transfer_start" };
    const job = await offramp.status("wd_1");
    expect(job.transfer).toBeUndefined();
    expect((await state.getJob("wd_1"))?.transfer ?? null).toBeNull();
  });

  it("rejects an unknown memo type and stores no instructions", async () => {
    stubAnchor();
    const { discovery, auth, state } = setup();
    await signIn(auth);
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });
    await startWithdrawal(offramp);

    transactionBody = {
      id: "wd_1",
      status: "pending_user_transfer_start",
      withdraw_anchor_account: ANCHOR_DEPOSIT_ACCOUNT,
      withdraw_memo: "x",
      withdraw_memo_type: "nonsense",
    };
    await expect(offramp.status("wd_1")).rejects.toBeInstanceOf(Sep6TransactionError);
    expect((await state.getJob("wd_1"))?.transfer ?? null).toBeNull();
  });
});
