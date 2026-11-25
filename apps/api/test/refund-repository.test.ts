import { describe, expect, it } from "vitest";
import type { Refund } from "@checkout/core";
import { bootstrap, createDb } from "../src/db/client";
import { DrizzleRefundRepository } from "../src/repos/index";
import { FakeRefundRepository } from "./fakes";

const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

async function freshRepo() {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return new DrizzleRefundRepository(db);
}

function refund(over: Partial<Refund> = {}): Refund {
  return {
    id: "rfd_1",
    linkId: "lnk_1",
    sellerId: "sel_1",
    paymentTxHash: "a".repeat(64),
    paymentOperationId: "1001",
    destination: "GBUYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    destinationMuxedId: null,
    memo: null,
    memoType: null,
    amount: "0.5",
    asset: USDC,
    status: "prepared",
    txHash: null,
    failureReason: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

describe("DrizzleRefundRepository (issue 4.58)", () => {
  it("round-trips every field of a refund, including nulls and a memo", async () => {
    const repo = await freshRepo();
    const full = refund({
      id: "rfd_full",
      destinationMuxedId: "42",
      memo: "deposit 7781",
      memoType: "text",
      asset: { code: "XLM", issuer: null },
      status: "failed",
      txHash: "b".repeat(64),
      failureReason: "tx_bad_seq",
      updatedAt: 2_000,
    });
    await repo.create(full);
    await repo.create(refund({ id: "rfd_plain" }));

    expect(await repo.findById("rfd_full")).toEqual(full);
    expect(await repo.findById("rfd_plain")).toEqual(refund({ id: "rfd_plain" }));
    expect(await repo.findById("rfd_missing")).toBeNull();
  });

  it("lists a link's refunds newest first, and no other link's", async () => {
    const repo = await freshRepo();
    await repo.create(refund({ id: "rfd_old", createdAt: 1_000 }));
    await repo.create(refund({ id: "rfd_new", createdAt: 3_000 }));
    await repo.create(refund({ id: "rfd_other", linkId: "lnk_2", createdAt: 2_000 }));

    expect((await repo.listByLink("lnk_1")).map((r) => r.id)).toEqual(["rfd_new", "rfd_old"]);
    expect((await repo.listByLink("lnk_none"))).toEqual([]);
  });

  it("lists by payment on both the tx hash and the operation id", async () => {
    const repo = await freshRepo();
    const tx = "c".repeat(64);
    await repo.create(refund({ id: "rfd_op1", paymentTxHash: tx, paymentOperationId: "1" }));
    // Same transaction, different operation: a different payer's payment.
    await repo.create(refund({ id: "rfd_op2", paymentTxHash: tx, paymentOperationId: "2" }));

    expect((await repo.listByPayment(tx, "1")).map((r) => r.id)).toEqual(["rfd_op1"]);
    expect((await repo.listByPayment(tx, "2")).map((r) => r.id)).toEqual(["rfd_op2"]);
    expect(await repo.listByPayment(tx, "3")).toEqual([]);
  });

  it("lists by status", async () => {
    const repo = await freshRepo();
    await repo.create(refund({ id: "rfd_p", status: "prepared" }));
    await repo.create(refund({ id: "rfd_s", status: "submitted", txHash: "d".repeat(64) }));

    expect((await repo.listByStatus("prepared")).map((r) => r.id)).toEqual(["rfd_p"]);
    expect((await repo.listByStatus("submitted")).map((r) => r.id)).toEqual(["rfd_s"]);
    expect(await repo.listByStatus("confirmed")).toEqual([]);
  });

  it("updates status, tx hash and failure reason, bumps updatedAt, and leaves the rest alone", async () => {
    const repo = await freshRepo();
    await repo.create(refund());

    const submitted = await repo.update("rfd_1", { status: "submitted", txHash: "e".repeat(64) });
    expect(submitted).toMatchObject({ status: "submitted", txHash: "e".repeat(64), failureReason: null, amount: "0.5" });
    expect(submitted!.updatedAt).toBeGreaterThan(1_000);

    const failed = await repo.update("rfd_1", { status: "failed", failureReason: "op_no_trust" });
    expect(failed).toMatchObject({ status: "failed", txHash: "e".repeat(64), failureReason: "op_no_trust" });
    expect(await repo.findById("rfd_1")).toEqual(failed);

    expect(await repo.update("rfd_missing", { status: "failed" })).toBeNull();
  });

  it("refuses two refunds with the same non-null tx hash, on create and on update", async () => {
    const repo = await freshRepo();
    const hash = "f".repeat(64);
    await repo.create(refund({ id: "rfd_a", txHash: hash, status: "submitted" }));

    await expect(repo.create(refund({ id: "rfd_b", txHash: hash, status: "submitted" }))).rejects.toThrow();

    await repo.create(refund({ id: "rfd_c" }));
    await expect(repo.update("rfd_c", { txHash: hash })).rejects.toThrow();
  });

  it("lets any number of refunds have no tx hash yet", async () => {
    const repo = await freshRepo();
    await repo.create(refund({ id: "rfd_1", txHash: null }));
    await repo.create(refund({ id: "rfd_2", txHash: null }));
    await repo.create(refund({ id: "rfd_3", txHash: null }));
    expect(await repo.listByStatus("prepared")).toHaveLength(3);
  });
});

// The claim is tested against the real table and against the fake the service
// tests use, so the two cannot drift apart.
describe.each([
  ["DrizzleRefundRepository", freshRepo],
  ["FakeRefundRepository", async () => new FakeRefundRepository()],
])("%s.claim (issue 4.62)", (_name, makeRepo) => {
  const PAYMENT = "10";

  it("stores the refund as given when the payment has that much left", async () => {
    const repo = await makeRepo();
    const wanted = refund({ id: "rfd_a", amount: "4", memo: "deposit 7781", memoType: "text" });

    expect(await repo.claim(wanted, PAYMENT)).toBe(true);
    expect(await repo.findById("rfd_a")).toEqual(wanted);
  });

  it("lets a claim for exactly what is left win, and one stroop more lose", async () => {
    const repo = await makeRepo();
    expect(await repo.claim(refund({ id: "rfd_a", amount: "4" }), PAYMENT)).toBe(true);

    expect(await repo.claim(refund({ id: "rfd_b", amount: "6.0000001" }), PAYMENT)).toBe(false);
    expect(await repo.findById("rfd_b")).toBeNull();
    expect(await repo.claim(refund({ id: "rfd_c", amount: "6" }), PAYMENT)).toBe(true);
    expect(await repo.claim(refund({ id: "rfd_d", amount: "0.0000001" }), PAYMENT)).toBe(false);
  });

  it("lets exactly one of two concurrent claims win when together they exceed the payment", async () => {
    const repo = await makeRepo();

    const results = await Promise.all([
      repo.claim(refund({ id: "rfd_a", amount: "6" }), PAYMENT),
      repo.claim(refund({ id: "rfd_b", amount: "6" }), PAYMENT),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.listByPayment("a".repeat(64), "1001")).toHaveLength(1);
  });

  it("lets both concurrent claims win when together they fit", async () => {
    const repo = await makeRepo();

    const results = await Promise.all([
      repo.claim(refund({ id: "rfd_a", amount: "5" }), PAYMENT),
      repo.claim(refund({ id: "rfd_b", amount: "5" }), PAYMENT),
    ]);

    expect(results).toEqual([true, true]);
  });

  it("counts prepared, submitted and confirmed refunds, and frees the amount of a failed one", async () => {
    const repo = await makeRepo();
    expect(await repo.claim(refund({ id: "rfd_a", amount: "10" }), PAYMENT)).toBe(true);
    expect(await repo.claim(refund({ id: "rfd_b", amount: "1" }), PAYMENT)).toBe(false);

    await repo.update("rfd_a", { status: "submitted", txHash: "b".repeat(64) });
    expect(await repo.claim(refund({ id: "rfd_b", amount: "1" }), PAYMENT)).toBe(false);
    await repo.update("rfd_a", { status: "confirmed" });
    expect(await repo.claim(refund({ id: "rfd_b", amount: "1" }), PAYMENT)).toBe(false);

    await repo.update("rfd_a", { status: "failed", failureReason: "tx_too_late" });
    expect(await repo.claim(refund({ id: "rfd_b", amount: "10" }), PAYMENT)).toBe(true);
  });

  it("counts only refunds of the same payment, by tx hash and by operation id", async () => {
    const repo = await makeRepo();
    await repo.create(refund({ id: "rfd_other_tx", amount: "10", paymentTxHash: "c".repeat(64) }));
    await repo.create(refund({ id: "rfd_other_op", amount: "10", paymentOperationId: "1002" }));

    expect(await repo.claim(refund({ id: "rfd_a", amount: "10" }), PAYMENT)).toBe(true);
  });

  it("adds amounts up in stroops, not as floating point numbers", async () => {
    const repo = await makeRepo();
    // 0.1 + 0.2 is not 0.3 in floating point.
    expect(await repo.claim(refund({ id: "rfd_a", amount: "0.1" }), "0.3")).toBe(true);
    expect(await repo.claim(refund({ id: "rfd_b", amount: "0.2" }), "0.3")).toBe(true);
    expect(await repo.claim(refund({ id: "rfd_c", amount: "0.0000001" }), "0.3")).toBe(false);

    // Beyond what a double holds exactly: 900 billion and one stroop.
    const big = refund({ id: "rfd_big", amount: "900000000000", paymentOperationId: "2001" });
    expect(await repo.claim(big, "900000000000.0000001")).toBe(true);
    const two = refund({ id: "rfd_two", amount: "0.0000002", paymentOperationId: "2001" });
    expect(await repo.claim(two, "900000000000.0000001")).toBe(false);
    const one = refund({ id: "rfd_one", amount: "0.0000001", paymentOperationId: "2001" });
    expect(await repo.claim(one, "900000000000.0000001")).toBe(true);
  });

  it("reads stored amounts written with and without decimals", async () => {
    const repo = await makeRepo();
    await repo.create(refund({ id: "rfd_int", amount: "3" }));
    await repo.create(refund({ id: "rfd_dec", amount: "2.5" }));
    await repo.create(refund({ id: "rfd_seven", amount: "0.0000001" }));

    expect(await repo.claim(refund({ id: "rfd_a", amount: "4.5" }), PAYMENT)).toBe(false);
    expect(await repo.claim(refund({ id: "rfd_b", amount: "4.4999999" }), PAYMENT)).toBe(true);
  });
});
