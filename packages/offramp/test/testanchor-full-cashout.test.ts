import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnchorCustomer, KycFieldSpec, WithdrawTransfer } from "@checkout/core";
import { TestAnchorKyc } from "../src/kyc";
import { TestAnchorOffRamp } from "../src/testanchor";
import { FakeOffRampStateRepository } from "./fake-state";
import {
  HORIZON_TESTNET,
  LIVE_ENABLED,
  LIVE_OFFRAMP_TYPE,
  MemoryKycRepository,
  USDC_TESTNET_ISSUER,
  anchorWiring,
  buildTransferPayment,
  ensureProbeAccount,
  failedCashoutStage,
  kycValuesFor,
  loadAccount,
  makeProbeKeypair,
  mergeProbeTelemetry,
  pollUntil,
  signedInAs,
  submitTransaction,
  type CashoutStage,
} from "./live-probe";

/**
 * Nightly full cash-out probe against testanchor.stellar.org (issue 8.14).
 *
 * The other live suites stop at "the anchor answered". This one does what a real
 * seller does, in order: sign in to the anchor, pass SEP-12 KYC, quote, start the
 * SEP-6 withdrawal, SEND THE USDC to the anchor on Horizon testnet with the
 * anchor's exact memo and memo type, and watch the anchor notice. If testanchor
 * changes its memo type, stops returning `account_id`, or asks for more KYC, this
 * is the suite that goes red while the rest stay green.
 *
 * The only key involved is the dedicated testnet probe key (SELLER_SECRET_KEY, CI
 * secret TEST_ANCHOR_SELLER_SECRET). This file stands in for the seller's wallet by
 * signing the payment in the test process; no code under src/ gains a key, and
 * `pnpm check:no-server-signing` still passes because it does not scan test/.
 *
 * Gated on RUN_LIVE_ANCHOR_TESTS=1 AND SELLER_SECRET_KEY: without a funded key
 * there is nothing to spend, so it is skipped, never failed. anchor-probe.yml runs
 * it as its own step (and excludes it from the SEP-1/10/38/6/24 step).
 *
 * Each `it` is one stage and is skipped once an earlier stage has failed, so the
 * first red test names where the flow broke. The last stage completed is also written
 * to probe-telemetry.json (`fullCashoutLastStage`, `fullCashoutFailedStage`) for the job summary.
 *
 * NOT exercised against the live anchor by the author: see the PR/commit notes.
 */
const LIVE_FULL_CASHOUT = LIVE_ENABLED && Boolean(process.env.SELLER_SECRET_KEY);

/** Small enough not to drain the probe wallet; override when testanchor's minimum is higher. */
const AMOUNT = process.env.PROBE_CASHOUT_AMOUNT ?? "1";

const KYC_TIMEOUT_MS = 120_000;
const INSTRUCTIONS_TIMEOUT_MS = 180_000;
const SETTLEMENT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

/** What testanchor needs to create a customer before it says what else it wants. */
const FIRST_SUBMISSION_FIELDS: KycFieldSpec[] = ["first_name", "last_name", "email_address"].map((name) => ({
  name,
  type: "string",
  optional: false,
}));

describe.skipIf(!LIVE_FULL_CASHOUT)("TestAnchorOffRamp full seller-signed cash-out (live)", () => {
  let wallet: Keypair;
  let wiring: ReturnType<typeof anchorWiring>;
  let customer: AnchorCustomer;
  let offramp: TestAnchorOffRamp;
  let state: FakeOffRampStateRepository;
  let quoteId = "";
  let jobId = "";
  let transfer: WithdrawTransfer | null = null;
  let lastCompleted: CashoutStage | null = null;

  /** Skip (not fail) a stage whose predecessor did not complete; record the ones that do. */
  const after = (previous: CashoutStage | null, skip: () => void) => {
    if (lastCompleted !== previous) skip();
  };
  const done = (stage: CashoutStage, timings: Record<string, unknown> = {}) => {
    lastCompleted = stage;
    mergeProbeTelemetry({ fullCashoutLastStage: stage, ...timings });
  };
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const started = Date.now();
    const value = await fn();
    return [value, Date.now() - started];
  };

  beforeAll(() => {
    wallet = makeProbeKeypair();
    mergeProbeTelemetry({ fullCashoutLastStage: null, fullCashoutFailedStage: null, fullCashoutSettled: false });
  });

  afterAll(() => {
    mergeProbeTelemetry({ fullCashoutFailedStage: failedCashoutStage(lastCompleted) });
  });

  it("stage 1/7 prepare: the probe wallet exists, trusts testnet USDC and holds enough of it", async () => {
    const { account } = await ensureProbeAccount({ keypair: wallet, minUsdc: Number(AMOUNT) });
    expect(account.id).toBe(wallet.publicKey());
    done("prepare");
  }, 120_000);

  it("stage 2/7 auth: a wallet-signed SEP-10 challenge yields a seller session", async (t) => {
    after("prepare", () => t.skip());
    const [signed, authMs] = await timed(() => signedInAs(wallet));
    wiring = signed.wiring;
    customer = signed.customer;
    state = new FakeOffRampStateRepository();
    offramp = new TestAnchorOffRamp({ ...wiring, state, preferredWithdrawType: LIVE_OFFRAMP_TYPE });
    expect(await wiring.auth.token(customer)).toBeTruthy();
    done("auth", { fullCashoutAuthMs: authMs });
  }, 60_000);

  it("stage 3/7 kyc: SEP-12 reaches ACCEPTED with the sandbox's test values", async (t) => {
    after("auth", () => t.skip());
    const kyc = new TestAnchorKyc({
      discovery: wiring.discovery,
      auth: wiring.auth,
      repo: new MemoryKycRepository(),
      profileRepo: { get: async () => null },
    });
    const [{ value: record }, kycMs] = await timed(() =>
      pollUntil(
        "KYC to be ACCEPTED",
        async () => {
          let current = await kyc.status(customer, { maxAgeMs: 0 });
          // The anchor is still reviewing what it was given: do not resubmit, just look again.
          if (current.status === "PROCESSING" || current.status === "ACCEPTED") return current;
          const required = current.requiredFields.length > 0 ? current.requiredFields : FIRST_SUBMISSION_FIELDS;
          const { send, missing } = kycValuesFor(required);
          if (missing.length > 0) {
            throw new Error(`testanchor now asks for KYC fields the probe has no test value for: ${missing.join(", ")}`);
          }
          current = await kyc.submit(customer, send);
          return current;
        },
        (r) => {
          if (r.status === "REJECTED") throw new Error(`testanchor rejected the probe's KYC: ${r.message ?? "(no message)"}`);
          return r.status === "ACCEPTED";
        },
        { timeoutMs: KYC_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      ),
    );
    expect(record.status).toBe("ACCEPTED");
    done("kyc", { fullCashoutKycMs: kycMs });
  }, KYC_TIMEOUT_MS + 30_000);

  it("stage 4/7 quote: SEP-38 returns a firm, unexpired quote", async (t) => {
    after("kyc", () => t.skip());
    const [quote, quoteMs] = await timed(() =>
      offramp.quote({
        linkId: "probe-full-cashout",
        sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
        sourceAmount: AMOUNT,
        targetCurrency: "USD",
        customer,
      }),
    );
    expect(Number(quote.rate)).toBeGreaterThan(0);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
    quoteId = quote.quoteId;
    done("quote", { fullCashoutQuoteMs: quoteMs });
  }, 60_000);

  it("stage 5/7 withdraw: SEP-6 yields transfer instructions that match the quote", async (t) => {
    after("quote", () => t.skip());
    const [initiation, withdrawMs] = await timed(() =>
      offramp.initiate({
        linkId: "probe-full-cashout",
        quoteId,
        payout: { currency: "USD", fields: { type: LIVE_OFFRAMP_TYPE, dest: "1234", dest_extra: "021000021" } },
        customer,
      }),
    );
    jobId = initiation.jobId;
    expect(jobId).toBeTruthy();

    if (initiation.kind === "transfer") {
      transfer = initiation.transfer;
    } else if (initiation.kind === "fields") {
      // The anchor publishes where to send only once its own checks finish.
      const { value } = await pollUntil(
        "the anchor to publish transfer instructions",
        () => offramp.status(jobId),
        (job) => job.transfer !== undefined || job.status === "failed",
        { timeoutMs: INSTRUCTIONS_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      );
      if (value.status === "failed") throw new Error(`withdrawal failed before instructions arrived: ${value.reason ?? "(no reason)"}`);
      transfer = value.transfer ?? null;
    } else {
      throw new Error(`unexpected initiation kind "${initiation.kind}" from the SEP-6 adapter`);
    }

    // The probe key is testnet-only, but it still must not pay whatever an anchor says: the
    // instructions have to be for the asset, issuer and amount that were quoted.
    expect(transfer).not.toBeNull();
    expect(transfer?.asset).toEqual({ code: "USDC", issuer: USDC_TESTNET_ISSUER });
    expect(Number(transfer?.amount)).toBeGreaterThan(0);
    expect(Number(transfer?.amount)).toBeLessThanOrEqual(Number(AMOUNT));
    expect(transfer?.destination).toMatch(/^[GM][A-Z2-7]{55,68}$/);
    done("withdraw", { fullCashoutWithdrawMs: withdrawMs });
  }, INSTRUCTIONS_TIMEOUT_MS + 60_000);

  it("stage 6/7 transfer: the seller's key pays the anchor on Horizon testnet with the exact memo", async (t) => {
    after("withdraw", () => t.skip());
    if (!transfer) throw new Error("no transfer instructions from the withdraw stage");

    const [hash, transferMs] = await timed(async () => {
      const account = await loadAccount(HORIZON_TESTNET, wallet.publicKey());
      if (!account) throw new Error("probe wallet disappeared from Horizon testnet");
      const tx = buildTransferPayment({ sourceAccount: account.id, sequence: account.sequence, transfer: transfer! });
      tx.sign(wallet);
      return submitTransaction(HORIZON_TESTNET, tx);
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    done("transfer", { fullCashoutTransferMs: transferMs, fullCashoutTransferHash: hash });
  }, 90_000);

  it("stage 7/7 settlement: the anchor sees the payment and moves past pending_user_transfer_start", async (t) => {
    after("transfer", () => t.skip());
    const started = Date.now();
    const { value: job } = await pollUntil(
      "the anchor to observe the transfer",
      async () => {
        const polled = await offramp.status(jobId);
        return { polled, external: (await state.getJob(jobId))?.externalStatus ?? null };
      },
      ({ polled, external }) => polled.status === "settled" || polled.status === "failed" || (external !== null && external !== "pending_user_transfer_start"),
      { timeoutMs: SETTLEMENT_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    const settlementMs = Date.now() - started;

    expect(job.polled.status, job.polled.reason).not.toBe("failed");
    const settled = job.polled.status === "settled";
    done("settlement", {
      fullCashoutSettlementMs: settlementMs,
      fullCashoutFinalStatus: job.external,
      fullCashoutSettled: settled,
    });
  }, SETTLEMENT_TIMEOUT_MS + 60_000);
});
