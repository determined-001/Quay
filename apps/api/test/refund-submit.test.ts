import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  refundableAmount,
  type RailPort,
  type Refund,
  type Seller,
  type SellerRepository,
} from "@checkout/core";
import { HttpError, LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeRefundRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

// ---------------------------------------------------------------------------
//  POST /links/:id/refunds/:refundId/submit — relaying the refund transaction
//  the seller signed in their wallet (issue 4.60).
//
//  4.59 stores the prepared transaction and its hash. The browser signs that
//  transaction and hands it back, so the envelope is entirely
//  attacker-controlled: every test here is a rejection of something that is
//  not exactly the prepared refund. Nothing reaches the network — every
//  assertion fires before Horizon, or on a mocked submit.
// ---------------------------------------------------------------------------

const SELLER = Keypair.random();
const BUYER = Keypair.random();
const ATTACKER = Keypair.random();
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", ISSUER);
const USDC_REF = { code: "USDC", issuer: ISSUER };

/** Every prepared refund expires well after the test run. */
const FUTURE = Math.floor(Date.now() / 1000) + 3_600;

const stellar = {
  network: "testnet" as const,
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
  usdcIssuer: ISSUER,
};

const seller: Seller = {
  id: "sel_1",
  name: "S",
  wallet: SELLER.publicKey(),
  profileKind: "individual",
  payoutFields: null,
  createdAt: 0,
};
const sellers: SellerRepository = {
  async findById() { return seller; },
  async findByWallet() { return seller; },
  async createIfAbsent() { return seller; },
  async savePayoutFields() {},
  async saveProfileKind() {},
};
const rail: RailPort = {
  buildRequest: () => ({
    uri: "web+stellar:pay",
    destination: SELLER.publicKey(),
    amount: "10",
    asset: USDC_REF,
    memo: "r",
  }),
  isValidDestination: () => true,
  async assertCanReceive() {},
};

let links: FakeLinkRepository;
let refunds: FakeRefundRepository;
let service: LinkService;
let relayed: Transaction[];
let submit: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  links = new FakeLinkRepository();
  refunds = new FakeRefundRepository();
  service = new LinkService({
    links,
    sellers,
    webhooks: new FakeWebhookRepository(),
    rail,
    refunds,
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
      status: "paid",
      txHash: "a".repeat(64),
      paidAmount: "10",
      destination: SELLER.publicKey(),
      amount: "10",
      asset: USDC_REF,
    }),
  );

  relayed = [];
  submit = vi
    .spyOn(Horizon.Server.prototype, "submitTransaction")
    .mockImplementation(async (submitted) => {
      const tx = submitted as Transaction;
      relayed.push(tx);
      return { hash: tx.hash().toString("hex") } as never;
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type BuildOverrides = {
  source?: Keypair;
  ops?: Parameters<TransactionBuilder["addOperation"]>[0][];
  memo?: Memo;
  maxTime?: number;
  sequence?: string;
};

/** The refund transaction 4.59 would prepare: seller's wallet -> buyer. */
function buildRefund(over: BuildOverrides = {}): Transaction {
  const signer = over.source ?? SELLER;
  const builder = new TransactionBuilder(new Account(signer.publicKey(), over.sequence ?? "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: over.maxTime ?? FUTURE },
  });
  const ops = over.ops ?? [Operation.payment({ destination: BUYER.publicKey(), asset: USDC, amount: "10" })];
  for (const op of ops) builder.addOperation(op);
  if (over.memo) builder.addMemo(over.memo);
  return builder.build();
}

/** The hash a Stellar transaction keeps across signing: what 4.59 stores. */
function hashOf(tx: Transaction): string {
  return tx.hash().toString("hex");
}

function signWith(tx: Transaction, keypair: Keypair): string {
  tx.sign(keypair);
  return tx.toXDR();
}

function refundRow(over: Partial<Refund> = {}): Refund {
  return {
    id: "rfd_1",
    linkId: "lnk_1",
    sellerId: "sel_1",
    paymentTxHash: "a".repeat(64),
    paymentOperationId: "1001",
    destination: BUYER.publicKey(),
    destinationMuxedId: null,
    memo: null,
    memoType: null,
    amount: "10",
    asset: USDC_REF,
    status: "prepared",
    unsignedTxHash: null,
    txHash: null,
    failureReason: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

/** Store the refund 4.59 prepared, including the hash of the unsigned transaction. */
async function storePrepared(prepared: Transaction, over: Partial<Refund> = {}): Promise<Refund> {
  const row = refundRow({ unsignedTxHash: hashOf(prepared), ...over });
  await refunds.create(row);
  return row;
}

/** The HttpError a submit is refused with. Fails the test if it is relayed instead. */
async function refused(xdr: string, linkId = "lnk_1", refundId = "rfd_1"): Promise<HttpError> {
  const err = await service.submitRefund(linkId, refundId, xdr).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(relayed).toEqual([]);
  return err as HttpError;
}

describe("submitRefund — a rejection leaves the refund untouched", () => {
  it("rejects a transaction sourced by another account", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({ source: ATTACKER });

    const err = await refused(signWith(attack, ATTACKER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/source does not match the seller's wallet/);
    expect(await refunds.findById("rfd_1")).toMatchObject({ status: "prepared", txHash: null });
  });

  it("rejects two operations, even when the first is the right payment", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({
      ops: [
        Operation.payment({ destination: BUYER.publicKey(), asset: USDC, amount: "10" }),
        Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "1000" }),
      ],
    });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/exactly one operation, got 2/);
  });

  it("rejects a per-operation source override", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({
      ops: [
        Operation.payment({
          destination: BUYER.publicKey(),
          asset: USDC,
          amount: "10",
          source: ATTACKER.publicKey(),
        }),
      ],
    });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/must not override the transaction source/);
  });

  it("rejects a non-payment operation", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({ ops: [Operation.changeTrust({ asset: USDC })] });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/single payment operation, got "changeTrust"/);
  });

  it("rejects a changed destination", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({
      ops: [Operation.payment({ destination: ATTACKER.publicKey(), asset: USDC, amount: "10" })],
    });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/destination does not match/);
  });

  it("rejects a changed asset, including the right code under another issuer", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const impostor = new Asset("USDC", ATTACKER.publicKey());
    for (const asset of [Asset.native(), impostor]) {
      const attack = buildRefund({
        ops: [Operation.payment({ destination: BUYER.publicKey(), asset, amount: "10" })],
      });
      const err = await refused(signWith(attack, SELLER));
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/Asset mismatch/);
    }
  });

  it("rejects a changed amount", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({
      ops: [Operation.payment({ destination: BUYER.publicKey(), asset: USDC, amount: "9.9999999" })],
    });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Amount mismatch: refund sends 10/);
  });

  it("rejects a changed memo", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const attack = buildRefund({ memo: Memo.text("someone else's memo") });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/memo does not match/);
  });

  it("rejects a memo of another type that stringifies the same", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared, { memo: "12345", memoType: "id" });
    const attack = buildRefund({ memo: Memo.text("12345") });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/memo does not match/);
  });

  it("rejects a transaction whose hash is not the prepared one, though every field matches", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    // Same source, destination, asset, amount and memo; a later expiry, so a
    // different transaction with a different hash.
    const attack = buildRefund({ maxTime: FUTURE + 10 });

    const err = await refused(signWith(attack, SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/does not match the prepared refund/);
    expect(relayed).toEqual([]);
  });

  it("rejects a prepared refund whose stored hash was never written", async () => {
    await storePrepared(buildRefund(), { unsignedTxHash: null });

    const err = await refused(signWith(buildRefund(), SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/no prepared transaction/);
  });

  it("rejects an expired refund", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const prepared = buildRefund({ maxTime: past });
    await storePrepared(prepared);

    const err = await refused(signWith(buildRefund({ maxTime: past }), SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/expired/);
  });

  it("404s another seller's refund and a refund of another link", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared, { id: "rfd_other_seller", sellerId: "sel_other" });
    await storePrepared(prepared, { id: "rfd_other_link", linkId: "lnk_other" });

    const otherSeller = await refused(signWith(buildRefund(), SELLER), "lnk_1", "rfd_other_seller");
    expect([otherSeller.status, otherSeller.message]).toEqual([404, "Refund not found"]);
    const otherLink = await refused(signWith(buildRefund(), SELLER), "lnk_1", "rfd_other_link");
    expect([otherLink.status, otherLink.message]).toEqual([404, "Refund not found"]);
    const unknown = await refused(signWith(buildRefund(), SELLER), "lnk_1", "rfd_nope");
    expect(unknown.status).toBe(404);
  });

  it("404s an unknown link", async () => {
    await storePrepared(buildRefund());
    const err = await refused(signWith(buildRefund(), SELLER), "lnk_nope");
    expect([err.status, err.message]).toEqual([404, "Link not found"]);
  });

  it("rejects a refund that is no longer prepared", async () => {
    await storePrepared(buildRefund(), { id: "rfd_failed", status: "failed" });
    const err = await refused(signWith(buildRefund(), SELLER), "lnk_1", "rfd_failed");
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/cannot be submitted/);
  });

  it("rejects malformed XDR", async () => {
    await storePrepared(buildRefund());
    const err = await refused("not-base64-xdr");
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/invalid_xdr/);
  });

  it("rejects a different envelope for an already-submitted refund", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared, { status: "submitted", txHash: hashOf(buildRefund({ maxTime: FUTURE + 5 })) });

    const err = await refused(signWith(buildRefund({ maxTime: FUTURE + 5 }), SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/already submitted/);
  });
});

describe("submitRefund — submission", () => {
  it("submits the prepared transaction, sets submitted with the hash, and does not confirm it", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);

    const result = await service.submitRefund("lnk_1", "rfd_1", signWith(buildRefund(), SELLER));

    const hash = hashOf(prepared);
    expect(result.txHash).toBe(hash);
    expect(relayed).toHaveLength(1);
    expect(await refunds.findById("rfd_1")).toMatchObject({
      status: "submitted",
      txHash: hash,
      failureReason: null,
    });
    // The ledger (2.15) owns `confirmed`, not this call.
    expect(result.refund.status).toBe("submitted");
  });

  it("takes an amount with the same value and another decimal representation", async () => {
    const prepared = buildRefund({
      ops: [Operation.payment({ destination: BUYER.publicKey(), asset: USDC, amount: "10.0000000" })],
    });
    await storePrepared(prepared, { amount: "10" });

    const result = await service.submitRefund(
      "lnk_1",
      "rfd_1",
      signWith(buildRefund({ ops: [Operation.payment({ destination: BUYER.publicKey(), asset: USDC, amount: "10.0000000" })] }), SELLER),
    );
    expect(result.txHash).toBe(hashOf(prepared));
    expect(relayed).toHaveLength(1);
  });

  it("returns the stored hash when the same signed XDR is submitted again", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    const xdr = signWith(buildRefund(), SELLER);

    const first = await service.submitRefund("lnk_1", "rfd_1", xdr);
    const second = await service.submitRefund("lnk_1", "rfd_1", xdr);

    expect(second.txHash).toBe(first.txHash);
    expect(second.refund.status).toBe("submitted");
    // Broadcast exactly once.
    expect(relayed).toHaveLength(1);
  });

  it("marks the refund failed with a mapped reason when Horizon rejects it, freeing the amount", async () => {
    const prepared = buildRefund();
    await storePrepared(prepared);
    submit.mockRejectedValueOnce(
      Object.assign(new Error("Request failed with status code 400"), {
        response: {
          status: 400,
          data: {
            extras: {
              result_codes: { transaction: "tx_failed", operations: ["op_underfunded"] },
            },
          },
        },
      }),
    );

    const err = await refused(signWith(buildRefund(), SELLER));
    expect(err.status).toBe(409);
    expect(err.message).toBe("refund_rejected");
    expect(err.extra).toMatchObject({ reason: "insufficient_balance" });

    const failed = await refunds.findById("rfd_1");
    expect(failed).toMatchObject({ status: "failed", txHash: null, failureReason: "insufficient_balance" });
    // A failed refund no longer reserves its amount (4.62): it is refundable again.
    const rows = await refunds.listByPayment("a".repeat(64), "1001");
    expect(refundableAmount("10", rows)).toBe("10");
  });
});
