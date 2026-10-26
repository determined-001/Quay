import { Keypair, Networks, Transaction, TransactionBuilder, Memo } from "@stellar/stellar-sdk";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CASHOUT_STAGES,
  MemoryKycRepository,
  PollTimeoutError,
  ProbeFundingError,
  USDC_TESTNET_ISSUER,
  buildTransferPayment,
  ensureProbeAccount,
  failedCashoutStage,
  isHttpsOnAnchor,
  kycValuesFor,
  mergeProbeTelemetry,
  pollUntil,
  submitTransaction,
  transferMemo,
} from "./live-probe";

// Offline coverage for the pure logic behind the live probe suites (issues 8.14, 8.16).
// Nothing here talks to testanchor.stellar.org or Horizon; fetch is stubbed.

const USDC = { code: "USDC", issuer: USDC_TESTNET_ISSUER } as const;
const ANCHOR_ACCOUNT = Keypair.random().publicKey();
const WALLET = Keypair.random();

describe("mergeProbeTelemetry", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "probe-telemetry-"));
    file = join(dir, "probe-telemetry.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the file, then merges later writers instead of overwriting them", () => {
    mergeProbeTelemetry({ rate: "1.01", quoteLatencyMs: 12 }, file);
    mergeProbeTelemetry({ sep24InitiateLatencyMs: 40 }, file);
    mergeProbeTelemetry({ quoteLatencyMs: 15 }, file);

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ rate: "1.01", quoteLatencyMs: 15, sep24InitiateLatencyMs: 40 });
  });

  it("releases its lock, so a second merge does not wait", () => {
    mergeProbeTelemetry({ a: 1 }, file);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("starts over from a corrupt file rather than failing the probe", () => {
    writeFileSync(file, "{ not json");
    expect(mergeProbeTelemetry({ a: 1 }, file)).toEqual({ a: 1 });
  });

  it("breaks a stale lock left by a crashed writer", () => {
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);

    expect(mergeProbeTelemetry({ a: 1 }, file, { staleLockMs: 1_000 })).toEqual({ a: 1 });
  });

  it("gives up on a lock that stays held", () => {
    mkdirSync(`${file}.lock`);
    expect(() => mergeProbeTelemetry({ a: 1 }, file, { attempts: 2 })).toThrow(/Could not lock/);
  });
});

describe("isHttpsOnAnchor", () => {
  it.each([
    ["https://testanchor.stellar.org/sep24/interactive?token=x", true],
    ["https://auth.testanchor.stellar.org/form", true],
    ["http://testanchor.stellar.org/form", false],
    ["https://testanchor.stellar.org.evil.example/form", false],
    ["https://eviltestanchor.stellar.org/form", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isHttpsOnAnchor(url, "testanchor.stellar.org")).toBe(expected);
  });
});

describe("pollUntil", () => {
  it("returns as soon as the predicate holds", async () => {
    const values = [1, 2, 3];
    const sleep = vi.fn(async () => {});
    const res = await pollUntil("n", async () => values.shift()!, (n) => n === 3, { timeoutMs: 1_000, intervalMs: 10, sleep });
    expect(res).toEqual({ value: 3, attempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("times out with the last value, without sleeping past the deadline", async () => {
    let t = 0;
    const err = await pollUntil("never", async () => "pending", () => false, {
      timeoutMs: 25,
      intervalMs: 10,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.last).toBe("pending");
    expect(err.attempts).toBe(3); // t = 0, 10, 20; a fourth wait would pass the 25ms deadline
  });
});

describe("kycValuesFor", () => {
  const spec = (name: string, optional = false) => ({ name, type: "string", optional });

  it("supplies a value for each required field and skips optional ones", () => {
    const { send, missing } = kycValuesFor([spec("first_name"), spec("email_address"), spec("tax_id", true)]);
    expect(Object.keys(send)).toEqual(["first_name", "email_address"]);
    expect(missing).toEqual([]);
  });

  it("names the required fields it has no value for, so the probe fails with a reason", () => {
    expect(kycValuesFor([spec("first_name"), spec("photo_id_front"), spec("favourite_colour")]).missing).toEqual([
      "photo_id_front",
      "favourite_colour",
    ]);
  });
});

describe("MemoryKycRepository", () => {
  it("round-trips a record per seller and anchor, and deletes it", async () => {
    const repo = new MemoryKycRepository();
    const record = { sellerId: "s1", anchorDomain: "a.example", callbackTokenHash: "h" } as never;
    await repo.save(record);
    expect(await repo.get("s1", "a.example")).toBe(record);
    expect(await repo.get("s1", "b.example")).toBeNull();
    expect(await repo.getByCallbackTokenHash("h")).toBe(record);
    await repo.delete("s1");
    expect(await repo.get("s1", "a.example")).toBeNull();
  });
});

describe("transferMemo", () => {
  it("maps text, id and hash memos, and none", () => {
    expect(transferMemo({ memo: "abc", memoType: "text" })).toEqual(Memo.text("abc"));
    expect(transferMemo({ memo: "12345", memoType: "id" })).toEqual(Memo.id("12345"));
    const hex = "ab".repeat(32);
    expect(transferMemo({ memo: Buffer.from(hex, "hex").toString("base64"), memoType: "hash" })).toEqual(Memo.hash(hex));
    expect(transferMemo({ memo: null, memoType: null })).toEqual(Memo.none());
  });

  it("refuses a memo whose type it cannot honour, rather than paying without it", () => {
    expect(() => transferMemo({ memo: "abc", memoType: null })).toThrow(/unusable memo type/);
  });
});

describe("buildTransferPayment", () => {
  const build = (transfer: Parameters<typeof buildTransferPayment>[0]["transfer"]) =>
    buildTransferPayment({ sourceAccount: WALLET.publicKey(), sequence: "100", transfer });

  it("pays the anchor's account the quoted USDC with the anchor's exact memo", () => {
    const tx = build({ destination: ANCHOR_ACCOUNT, amount: "1.0000000", asset: USDC, memo: "wd-123", memoType: "text" });
    // Round-trip through XDR to inspect what would actually be signed.
    const parsed = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET) as Transaction;
    expect(parsed.memo.type).toBe("text");
    expect(String(parsed.memo.value)).toBe("wd-123");
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]).toMatchObject({
      type: "payment",
      destination: ANCHOR_ACCOUNT,
      amount: "1.0000000",
      asset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
    });
    expect(parsed.source).toBe(WALLET.publicKey());
  });

  it("uses an id memo when the anchor says so", () => {
    const tx = build({ destination: ANCHOR_ACCOUNT, amount: "2", asset: USDC, memo: "98765", memoType: "id" });
    expect(tx.memo).toEqual(Memo.id("98765"));
  });

  it("refuses native XLM: the probe only ever sends the quoted issued asset", () => {
    expect(() => build({ destination: ANCHOR_ACCOUNT, amount: "1", asset: { code: "XLM", issuer: null }, memo: null, memoType: null })).toThrow(
      /issued assets/,
    );
  });
});

/** A tiny Horizon + Friendbot stand-in. */
function fakeHorizon(initial: { exists: boolean; trusted: boolean; usdc: string }) {
  const state = { ...initial, friendbotCalls: 0, submitted: [] as string[] };
  const account = () => ({
    id: WALLET.publicKey(),
    sequence: "1",
    balances: [
      { asset_type: "native", balance: "10000.0000000" },
      ...(state.trusted ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_TESTNET_ISSUER, balance: state.usdc }] : []),
    ],
  });
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (url.includes("friendbot")) {
      state.friendbotCalls++;
      state.exists = true;
      return new Response("{}", { status: 200 });
    }
    if (url.endsWith("/transactions") && init?.method === "POST") {
      state.submitted.push(String(init.body));
      state.trusted = true; // the only transaction this probe submits here is changeTrust
      return Response.json({ hash: "a".repeat(64) });
    }
    if (url.includes("/accounts/")) return state.exists ? Response.json(account()) : new Response("{}", { status: 404 });
    return new Response("{}", { status: 500 });
  };
  return { state, fetchImpl };
}

describe("ensureProbeAccount", () => {
  it("does nothing to an account that is already funded and trusted", async () => {
    const h = fakeHorizon({ exists: true, trusted: true, usdc: "25.0000000" });
    const res = await ensureProbeAccount({ keypair: WALLET, minUsdc: 1, fetchImpl: h.fetchImpl });
    expect(res).toMatchObject({ created: false, trustlineAdded: false });
    expect(h.state.friendbotCalls).toBe(0);
    expect(h.state.submitted).toEqual([]);
  });

  it("creates a missing account through Friendbot and adds the USDC trustline, then reports the empty balance", async () => {
    const h = fakeHorizon({ exists: false, trusted: false, usdc: "0.0000000" });
    const err = await ensureProbeAccount({ keypair: WALLET, minUsdc: 1, fetchImpl: h.fetchImpl }).catch((e) => e);
    expect(h.state.friendbotCalls).toBe(1);
    expect(h.state.submitted).toHaveLength(1);
    expect(err).toBeInstanceOf(ProbeFundingError);
    expect(err.message).toContain("holds 0 testnet USDC but needs 1");
    expect(err.message).toContain("Nightly anchor probe");
  });

  it("fails when Friendbot refuses", async () => {
    const fetchImpl = async (url: string) => (url.includes("friendbot") ? new Response("", { status: 503 }) : new Response("{}", { status: 404 }));
    await expect(ensureProbeAccount({ keypair: WALLET, minUsdc: 1, fetchImpl })).rejects.toThrow(/Friendbot could not fund/);
  });
});

describe("submitTransaction", () => {
  const tx = buildTransferPayment({
    sourceAccount: WALLET.publicKey(),
    sequence: "1",
    transfer: { destination: ANCHOR_ACCOUNT, amount: "1", asset: USDC, memo: null, memoType: null },
  });

  it("returns the hash on success", async () => {
    await expect(submitTransaction("https://h", tx, async () => Response.json({ hash: "b".repeat(64) }))).resolves.toBe("b".repeat(64));
  });

  it("surfaces Horizon's result codes on rejection", async () => {
    const rejected = async () =>
      Response.json({ title: "Transaction Failed", extras: { result_codes: { transaction: "tx_bad_seq" } } }, { status: 400 });
    await expect(submitTransaction("https://h", tx, rejected)).rejects.toThrow(/tx_bad_seq/);
  });
});

describe("failedCashoutStage", () => {
  it("names the first stage after the last one that completed", () => {
    expect(failedCashoutStage(null)).toBe("prepare");
    expect(failedCashoutStage("auth")).toBe("kyc");
    expect(failedCashoutStage("transfer")).toBe("settlement");
  });

  it("is null once every stage has completed", () => {
    expect(failedCashoutStage(CASHOUT_STAGES[CASHOUT_STAGES.length - 1]!)).toBeNull();
  });
});
