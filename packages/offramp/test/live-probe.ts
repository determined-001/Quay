import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  type MemoType,
} from "@stellar/stellar-sdk";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AnchorCustomer, KycFieldSpec, KycRecord, KycRepository, WithdrawTransfer } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { TESTANCHOR_BASE_URL, TESTANCHOR_HOME_DOMAIN } from "../src/testanchor";
import { FakeAnchorSessionRepository } from "./fake-state";

/**
 * Helpers shared by the live (testanchor) probe suites: `testanchor.test.ts`
 * (SEP-1/10/38/6), the SEP-24 suite in `anchor.test.ts`, and
 * `testanchor-full-cashout.test.ts`.
 *
 * The functions that take a `fetchImpl` / `sleep` / file path are exercised
 * offline by `live-probe.test.ts`; only the suites that call the real anchor
 * are skipped without RUN_LIVE_ANCHOR_TESTS.
 */

export const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_TESTNET = "https://friendbot.stellar.org";

/** True when the operator asked for the live suites. */
export const LIVE_ENABLED = Boolean(process.env.RUN_LIVE_ANCHOR_TESTS);

/** The withdraw type the live suites cash out through. */
export const LIVE_OFFRAMP_TYPE = process.env.OFFRAMP_TYPE ?? "bank_account";

/** The dedicated testnet probe key when supplied, otherwise a throwaway one. */
export function makeProbeKeypair(): Keypair {
  return process.env.SELLER_SECRET_KEY ? Keypair.fromSecret(process.env.SELLER_SECRET_KEY) : Keypair.random();
}

export function anchorWiring() {
  const discovery = new AnchorDiscovery({ homeDomain: TESTANCHOR_HOME_DOMAIN, fallbackBaseUrl: TESTANCHOR_BASE_URL });
  const sessions = new FakeAnchorSessionRepository();
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
  return { discovery, auth, sessions };
}

/** Sign the live anchor's challenge with `wallet`'s key, as the seller's wallet would in the browser. */
export async function signedInAs(wallet: Keypair, wiring = anchorWiring()) {
  const customer: AnchorCustomer = { sellerId: "sel_live", account: wallet.publicKey() };
  const { transaction } = await wiring.auth.challenge(customer);
  const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
  tx.sign(wallet);
  await wiring.auth.complete(customer, tx.toXDR());
  return { wiring, customer };
}

// ---------------------------------------------------------------------------
// probe-telemetry.json
// ---------------------------------------------------------------------------

export const PROBE_TELEMETRY_FILE = "probe-telemetry.json";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Merge `patch` into the telemetry file (creating it) and return the result.
 *
 * Vitest runs test files in parallel workers and several live suites write here,
 * so a plain read-then-write would drop one suite's values. A `mkdir` lock
 * serialises the read-modify-write; a lock older than `staleLockMs` (a crashed
 * writer) is broken rather than waited on forever.
 */
export function mergeProbeTelemetry(
  patch: Record<string, unknown>,
  file = PROBE_TELEMETRY_FILE,
  { staleLockMs = 10_000, attempts = 100 }: { staleLockMs?: number; attempts?: number } = {},
): Record<string, unknown> {
  const lock = `${file}.lock`;
  let held = false;
  for (let i = 0; i < attempts && !held; i++) {
    try {
      mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleLockMs) rmSync(lock, { recursive: true, force: true });
      } catch {
        // The holder released it between the two calls; just retry.
      }
      sleepSync(25);
    }
  }
  if (!held) throw new Error(`Could not lock ${file} for a telemetry merge`);
  try {
    let current: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        current = {}; // A half-written file from a crashed run: start over rather than fail the probe.
      }
    }
    const merged = { ...current, ...patch };
    writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** An https URL on the anchor's own domain (or a subdomain of it). */
export function isHttpsOnAnchor(url: string, anchorDomain: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const domain = anchorDomain.toLowerCase();
    return u.protocol === "https:" && (host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export class PollTimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly attempts: number,
    readonly last: unknown,
  ) {
    super(`Timed out waiting for ${what} after ${attempts} attempt(s)`);
    this.name = "PollTimeoutError";
  }
}

/** Call `fn` until `done(value)` or `timeoutMs` elapses (then throw {@link PollTimeoutError}). Always calls once. */
export async function pollUntil<T>(
  what: string,
  fn: () => Promise<T>,
  done: (value: T) => boolean,
  {
    timeoutMs,
    intervalMs,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
  }: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ value: T; attempts: number }> {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let last: T;
  for (;;) {
    attempts++;
    last = await fn();
    if (done(last)) return { value: last, attempts };
    if (now() + intervalMs > deadline) throw new PollTimeoutError(what, attempts, last);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// SEP-12: values for testanchor's KYC form
// ---------------------------------------------------------------------------

/**
 * Throwaway identity for the sandbox, keyed by SEP-9 field name. Obviously fake
 * (RFC 2606 email domain, the 555-01xx reserved phone range, the ACH routing
 * number every bank test suite uses). The anchor decides which of these it asks
 * for, so `kycValuesFor` picks from the fields it actually requires.
 */
export const PROBE_KYC_VALUES: Readonly<Record<string, string>> = {
  first_name: "Quay",
  last_name: "Probe",
  email_address: "quay-probe@example.com",
  mobile_number: "+14155550100",
  birth_date: "1990-01-01",
  address: "1 Test Street",
  city: "Testville",
  state_or_province: "CA",
  postal_code: "94105",
  address_country_code: "USA",
  id_type: "passport",
  id_number: "X0000000",
  id_country_code: "USA",
  bank_number: "021000021",
  bank_account_number: "1234",
  bank_account_type: "checking",
  tax_id: "000-00-0000",
};

/** The probe values for the required (non-optional) fields, and the ones we have no value for. */
export function kycValuesFor(required: readonly KycFieldSpec[]): { send: Record<string, string>; missing: string[] } {
  const send: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of required) {
    if (field.optional) continue;
    const value = PROBE_KYC_VALUES[field.name];
    if (value === undefined) missing.push(field.name);
    else send[field.name] = value;
  }
  return { send, missing };
}

/** In-memory KycRepository for the probe, which has no database. */
export class MemoryKycRepository implements KycRepository {
  private readonly rows = new Map<string, KycRecord>();
  async get(sellerId: string, anchorDomain: string) {
    return this.rows.get(`${sellerId} ${anchorDomain}`) ?? null;
  }
  async getByCallbackTokenHash(tokenHash: string) {
    return [...this.rows.values()].find((r) => r.callbackTokenHash === tokenHash) ?? null;
  }
  async save(record: KycRecord) {
    this.rows.set(`${record.sellerId} ${record.anchorDomain}`, record);
  }
  async delete(sellerId: string, anchorDomain?: string) {
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(`${sellerId} `) && (!anchorDomain || key === `${sellerId} ${anchorDomain}`)) this.rows.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// The seller's on-chain transfer, built the way the seller's wallet would
// ---------------------------------------------------------------------------

/** The Stellar memo for the anchor's instruction. A `hash` memo travels base64-encoded in SEP-6/24. */
export function transferMemo(transfer: Pick<WithdrawTransfer, "memo" | "memoType">): Memo<MemoType> {
  if (transfer.memo === null || transfer.memo === "") return Memo.none();
  switch (transfer.memoType) {
    case "text":
      return Memo.text(transfer.memo);
    case "id":
      return Memo.id(transfer.memo);
    case "hash":
      return Memo.hash(Buffer.from(transfer.memo, "base64").toString("hex"));
    default:
      throw new Error(`Anchor sent a memo (${JSON.stringify(transfer.memo)}) with unusable memo type ${JSON.stringify(transfer.memoType)}`);
  }
}

/** The (unsigned) payment transaction that carries out `transfer`, with the anchor's exact memo. */
export function buildTransferPayment(args: {
  sourceAccount: string;
  sequence: string;
  transfer: WithdrawTransfer;
  networkPassphrase?: string;
  fee?: string;
}): Transaction {
  const { sourceAccount, sequence, transfer, networkPassphrase = Networks.TESTNET, fee = "10000" } = args;
  if (transfer.asset.issuer === null) throw new Error("The probe only sends issued assets (USDC), not native XLM");
  return new TransactionBuilder(new Account(sourceAccount, sequence), { fee, networkPassphrase })
    .addOperation(
      Operation.payment({
        destination: transfer.destination,
        asset: new Asset(transfer.asset.code, transfer.asset.issuer),
        amount: transfer.amount,
      }),
    )
    .addMemo(transferMemo(transfer))
    .setTimeout(180)
    .build();
}

// ---------------------------------------------------------------------------
// Horizon testnet (plain REST so a stubbed fetch can stand in for it)
// ---------------------------------------------------------------------------

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}
export interface HorizonAccount {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
}

export async function loadAccount(horizon: string, id: string, fetchImpl: FetchImpl = fetch): Promise<HorizonAccount | null> {
  const res = await fetchImpl(`${horizon}/accounts/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon GET /accounts/${id} returned ${res.status}`);
  return (await res.json()) as HorizonAccount;
}

/** Submit a signed transaction; throws with Horizon's result codes on rejection. */
export async function submitTransaction(horizon: string, tx: Transaction, fetchImpl: FetchImpl = fetch): Promise<string> {
  const res = await fetchImpl(`${horizon}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toXDR() }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as {
    hash?: string;
    extras?: { result_codes?: unknown };
    title?: string;
  };
  if (!res.ok || !body.hash) {
    throw new Error(
      `Horizon rejected the transaction (${res.status}): ${body.title ?? ""} ${JSON.stringify(body.extras?.result_codes ?? {})}`.trim(),
    );
  }
  return body.hash;
}

export function usdcBalance(account: HorizonAccount, issuer = USDC_TESTNET_ISSUER): { trusted: boolean; balance: number } {
  const line = account.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === issuer);
  return { trusted: Boolean(line), balance: line ? Number(line.balance) : 0 };
}

export class ProbeFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeFundingError";
  }
}

/**
 * Make the probe wallet able to cash out `minUsdc`: create it through Friendbot if it does not
 * exist, add the testnet USDC trustline if missing, and require the balance. A shortfall is a
 * {@link ProbeFundingError} with the top-up procedure (docs/RUNBOOK.md, "Nightly anchor probe"):
 * testanchor's deposit needs its hosted KYC/interactive form, which a nightly job cannot drive.
 */
export async function ensureProbeAccount(args: {
  keypair: Keypair;
  minUsdc: number;
  horizon?: string;
  friendbot?: string;
  fetchImpl?: FetchImpl;
}): Promise<{ account: HorizonAccount; created: boolean; trustlineAdded: boolean }> {
  const { keypair, minUsdc, horizon = HORIZON_TESTNET, friendbot = FRIENDBOT_TESTNET, fetchImpl = fetch } = args;
  const id = keypair.publicKey();

  let account = await loadAccount(horizon, id, fetchImpl);
  let created = false;
  if (!account) {
    const res = await fetchImpl(`${friendbot}/?addr=${id}`);
    if (!res.ok) throw new ProbeFundingError(`Friendbot could not fund ${id} (${res.status})`);
    created = true;
    account = await loadAccount(horizon, id, fetchImpl);
    if (!account) throw new ProbeFundingError(`${id} still does not exist on testnet after Friendbot`);
  }

  let trustlineAdded = false;
  if (!usdcBalance(account).trusted) {
    const tx = new TransactionBuilder(new Account(id, account.sequence), { fee: "10000", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_TESTNET_ISSUER) }))
      .setTimeout(180)
      .build();
    tx.sign(keypair);
    await submitTransaction(horizon, tx, fetchImpl);
    trustlineAdded = true;
    account = (await loadAccount(horizon, id, fetchImpl)) ?? account;
  }

  const { balance } = usdcBalance(account);
  if (balance < minUsdc) {
    throw new ProbeFundingError(
      `Probe wallet ${id} holds ${balance} testnet USDC but needs ${minUsdc}. Top it up (docs/RUNBOOK.md, "Nightly anchor probe").`,
    );
  }
  return { account, created, trustlineAdded };
}

// ---------------------------------------------------------------------------
// Full cash-out progress, for the job summary
// ---------------------------------------------------------------------------

/** The stages of the full cash-out probe, in order. The first one not reached is where it failed. */
export const CASHOUT_STAGES = ["prepare", "auth", "kyc", "quote", "withdraw", "transfer", "settlement"] as const;
export type CashoutStage = (typeof CASHOUT_STAGES)[number];

/** Which stage failed, given the last one completed (null = none), or null when all completed. */
export function failedCashoutStage(lastCompleted: CashoutStage | null): CashoutStage | null {
  const next = lastCompleted === null ? 0 : CASHOUT_STAGES.indexOf(lastCompleted) + 1;
  return CASHOUT_STAGES[next] ?? null;
}
