import { CannotReceiveError, type CannotReceiveReason } from "@checkout/core";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { checkRefundReceivingCapability } from "../src/services/link-service";

const payer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const asset = { code: "USDC", issuer: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)) };
const ready = { kind: "ready", destination: payer } as const;

describe("refund receiving preflight", () => {
  it("checks the recorded payer and passes the exact amount to the rail", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    const amount = "12.3400001";
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, amount, ready))
      .resolves.toEqual({ ok: true, destination: payer, memoRequired: false });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, amount);
  });

  it("preserves a muxed refund destination while checking the base account", async () => {
    const destination = StrKey.encodeMed25519PublicKey(Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(8, 3)]));
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "ready", destination }))
      .resolves.toEqual({ ok: true, destination, memoRequired: false });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, "1");
  });

  it.each([
    ["account_not_found", /valid refund address/],
    ["no_trustline", /add the required trustline/],
    ["trustline_not_authorized", /asset issuer/],
    ["trustline_limit_exceeded", /increase the limit/],
  ] satisfies [CannotReceiveReason, RegExp][])("offers a next step for %s", async (reason, message) => {
    const rail = { assertCanReceive: vi.fn().mockRejectedValue(new CannotReceiveError(reason, "internal details")) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", ready))
      .resolves.toEqual({ ok: false, reason, message: expect.stringMatching(message) });
  });

  it("rejects a missing account found during destination resolution", async () => {
    const rail = { assertCanReceive: vi.fn() };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "account_gone" }))
      .resolves.toMatchObject({ ok: false, reason: "account_not_found" });
    expect(rail.assertCanReceive).not.toHaveBeenCalled();
  });

  it("requires the buyer's deposit memo after receiving checks pass", async () => {
    const rail = { assertCanReceive: vi.fn(async () => {}) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", { kind: "needs_memo", destination: payer }))
      .resolves.toEqual({
        ok: false,
        reason: "memo_required",
        message: expect.stringContaining("correct deposit memo"),
      });
    expect(rail.assertCanReceive).toHaveBeenCalledExactlyOnceWith(payer, asset, "1");
  });

  it.each(["0", "-1", "NaN", "+1", "1.", "1e-7", "0.00000001", " 1", "922337203685.4775808"])(
    "rejects invalid amount %j before calling the rail",
    async (amount) => {
      const rail = { assertCanReceive: vi.fn() };
      await expect(checkRefundReceivingCapability(rail, { payer }, asset, amount, ready))
        .rejects.toMatchObject({ status: 400, message: "invalid_refund_amount" });
      expect(rail.assertCanReceive).not.toHaveBeenCalled();
    },
  );

  it("propagates an unexpected rail failure", async () => {
    const error = new Error("Horizon unavailable");
    const rail = { assertCanReceive: vi.fn().mockRejectedValue(error) };
    await expect(checkRefundReceivingCapability(rail, { payer }, asset, "1", ready)).rejects.toBe(error);
  });
});
