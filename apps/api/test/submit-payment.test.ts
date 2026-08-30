import { describe, it, expect, beforeEach } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { RailPort, Seller, SellerRepository } from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { HttpError, LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

// ---------------------------------------------------------------------------
//  POST /links/:id/submit — validating a wallet-signed XDR (issue #31).
//
//  The buyer signs locally and we only relay, so the envelope is entirely
//  attacker-controlled. Every test here is a rejection: the point of the
//  endpoint is what it refuses to pass on to Horizon.
//
//  None of these reach the network — each assertion fires before submission.
// ---------------------------------------------------------------------------

const DEST = Keypair.random().publicKey();
const BUYER = Keypair.random();
const ATTACKER = Keypair.random();
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", ISSUER);

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  usdcIssuer: ISSUER,
};

const seller: Seller = { id: "sel_1", name: "S", wallet: DEST, payoutFields: null, createdAt: 0 };
const sellers: SellerRepository = {
  async getDefault() { return seller; },
  async findById() { return seller; },
  async findByWallet() { return seller; },
  async createIfAbsent() { return seller; },
  async savePayoutFields() {},
};
const rail: RailPort = {
  buildRequest: () => ({ uri: "web+stellar:pay", destination: DEST, amount: "10", asset: { code: "USDC", issuer: ISSUER }, memo: "r" }),
  isValidDestination: () => true,
  async assertCanReceive() {},
};

let links: FakeLinkRepository;
let service: LinkService;

beforeEach(async () => {
  links = new FakeLinkRepository();
  service = new LinkService({
    links,
    sellers,
    webhooks: new FakeWebhookRepository(),
    rail,
    offramp: new ScriptedOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    telemetry: new FakeTelemetryRepository(),
    stellar,
    correlation: "memo",
  });
  await links.save(
    makeLink({
      id: "lnk_1",
      reference: "pl_ref1",
      status: "active",
      txHash: null,
      paidAmount: null,
      destination: DEST,
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
    }),
  );
});

/** Builds a signed envelope, defaulting to the exact payment the link asks for. */
function build(
  ops: Parameters<TransactionBuilder["addOperation"]>[0][] = [
    Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
  ],
  memo: Memo = Memo.text("pl_ref1"),
): string {
  const source = new Account(BUYER.publicKey(), "1");
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.addMemo(memo).setTimeout(300).build();
  tx.sign(BUYER);
  return tx.toXDR();
}

async function expectRejected(xdr: string, status: number, match: RegExp) {
  await expect(service.submitPayment("lnk_1", xdr)).rejects.toThrow(match);
  await service.submitPayment("lnk_1", xdr).catch((err) => {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(status);
  });
}

describe("submitPayment — envelope validation", () => {
  // The one that matters most. An envelope whose FIRST operation is exactly the
  // payment we asked for, followed by anything at all. Validating operations[0]
  // and relaying the envelope would submit every one of them.
  it("rejects a second operation hidden behind a valid payment", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
      Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "1000" }),
    ]);
    await expectRejected(xdr, 400, /exactly one operation, got 2/);
  });

  it("rejects a trailing setOptions that would add a signer", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
      Operation.setOptions({ signer: { ed25519PublicKey: ATTACKER.publicKey(), weight: 255 } }),
    ]);
    await expectRejected(xdr, 400, /exactly one operation/);
  });

  it("rejects a trailing accountMerge", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10" }),
      Operation.accountMerge({ destination: ATTACKER.publicKey() }),
    ]);
    await expectRejected(xdr, 400, /exactly one operation/);
  });

  it("rejects a non-payment operation", async () => {
    const xdr = build([Operation.changeTrust({ asset: USDC })]);
    await expectRejected(xdr, 400, /single payment operation, got "changeTrust"/);
  });

  it("rejects an operation-level source override", async () => {
    const xdr = build([
      Operation.payment({ destination: DEST, asset: USDC, amount: "10", source: ATTACKER.publicKey() }),
    ]);
    await expectRejected(xdr, 400, /must not override the transaction source/);
  });

  it("rejects a wrong destination", async () => {
    const xdr = build([Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "10" })]);
    await expectRejected(xdr, 409, /destination does not match/);
  });

  it("rejects a wrong asset", async () => {
    const xdr = build([Operation.payment({ destination: DEST, asset: Asset.native(), amount: "10" })]);
    await expectRejected(xdr, 409, /Asset mismatch/);
  });

  it("rejects an asset with the right code but a different issuer", async () => {
    const impostor = new Asset("USDC", ATTACKER.publicKey());
    const xdr = build([Operation.payment({ destination: DEST, asset: impostor, amount: "10" })]);
    await expectRejected(xdr, 409, /Asset mismatch/);
  });

  it("rejects an underpayment", async () => {
    const xdr = build([Operation.payment({ destination: DEST, asset: USDC, amount: "9.9999999" })]);
    await expectRejected(xdr, 409, /Amount too low/);
  });

  it("rejects a mismatched memo", async () => {
    const xdr = build(undefined, Memo.text("someone_elses_ref"));
    await expectRejected(xdr, 409, /memo does not match/i);
  });

  it("rejects a missing memo", async () => {
    const xdr = build(undefined, Memo.none());
    await expectRejected(xdr, 409, /memo does not match/i);
  });

  it("rejects a MEMO_ID where MEMO_TEXT was required", async () => {
    // The reference is a text memo. An id memo that happens to stringify
    // similarly must not be accepted as correlation.
    const xdr = build(undefined, Memo.id("12345"));
    await expectRejected(xdr, 409, /memo does not match/i);
  });

  // Signature authenticity — including which network it was signed for — is
  // Horizon's to decide, and it is authoritative. This layer owns the envelope's
  // *contents*: what the transaction would do if it were valid. A pubnet-signed
  // envelope parses cleanly against the testnet passphrase (the XDR carries no
  // network), passes every content check, and is then rejected on submission for
  // a bad signature. Asserting a local rejection here would be asserting
  // signature verification this service deliberately does not duplicate.

  it("rejects malformed XDR", async () => {
    await expectRejected("not-base64-xdr", 400, /invalid_xdr/);
  });

  it("404s an unknown link", async () => {
    await expect(service.submitPayment("lnk_nope", build())).rejects.toThrow(/Link not found/);
  });

  it("409s a link that is no longer open", async () => {
    await links.save(makeLink({ id: "lnk_1", reference: "pl_ref1", status: "paid", destination: DEST }));
    await expect(service.submitPayment("lnk_1", build())).rejects.toThrow(/cannot accept payment/);
  });
});
