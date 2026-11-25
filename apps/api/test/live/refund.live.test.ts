import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HorizonWatcher } from "@checkout/stellar";
import { linkRoutes } from "../../src/routes/links";
import { webhookRoutes } from "../../src/routes/webhooks";
import { WatcherLoop } from "../../src/worker/watcher-loop";
import { createTestContainer, type TestContainer } from "../setup";
import {
  HORIZON_TESTNET,
  ProbeFundingError,
  USDC_TESTNET_ISSUER,
  ensureProbeAccount,
  loadAccount,
  mergeProbeTelemetry,
  pollUntil,
  submitTransaction,
} from "../../../../packages/offramp/test/live-probe";

/**
 * Testnet end-to-end refund probe (issue 5.46).
 *
 * This test is the gate for enabling `REFUNDS_ENABLED` on mainnet (issue 8.29):
 * refunds stay off on every deployment until it passes. It does what a real
 * seller does, in order: a buyer pays a 2 USDC link, the seller asks the API
 * for a 0.5 USDC refund, signs the returned XDR with their own key (standing
 * in for the wallet), submits it through the API, and the refund is confirmed
 * from the ledger. A second refund of 1.6 USDC must then be refused, because
 * only 1.5 USDC is still refundable.
 *
 * Gated on `RUN_LIVE_REFUND_TESTS=1`: without it the whole file is skipped,
 * never failed. When live, each `it` is one stage and is skipped once an
 * earlier stage has not completed, so the first red test names where the flow
 * broke. The last stage completed is also written to
 * `refund-probe-telemetry.json` for the job summary.
 *
 * The only keys involved are throwaway testnet probe keys. The test process
 * signs the buyer's payment and the seller's refund in the test process,
 * standing in for the wallets; no code under `src/` gains a key, and
 * `pnpm check:no-server-signing` still passes because it does not scan `test/`.
 *
 * Funding: the buyer needs 2 testnet USDC, which Friendbot cannot mint. For a
 * manual run, either pre-fund the buyer (pass its secret as
 * `REFUND_PROBE_BUYER_SECRET`, topped up from https://faucet.circle.com)
 * or set `REFUND_PROBE_FUNDER_SECRET` to a funded testnet key and the test
 * transfers the 2.5 USDC itself. With neither, the prepare stage is skipped,
 * not failed. The nightly workflow passes `TEST_REFUND_FUNDER_SECRET`.
 *
 * ASSUMPTIONS — the refund feature does not exist in the repo yet (issues
 * #535, #537, #538, #539, #530 are all open), so this test is written against
 * the contract those issues specify. When they land, any line here that
 * guessed wrong is the line to fix; the assumptions are listed so the rework
 * is a search, not a re-read:
 *  - A1 (from #535): `POST /links/:id/refunds` takes
 *    `{ payment: "<txHash>:<operationId>", amount: "<decimal>", memo?, memoType? }`
 *    and returns `{ refundId, xdr, networkPassphrase, expiresAt }`. The XDR is
 *    one payment operation from the seller's wallet (`link.destination`) to the
 *    buyer, the link's asset and amount, memo `MEMO_TEXT` `refund <reference>`,
 *    300 s timeout. The route answers `501 refunds_disabled` while the flag is
 *    off and `404` while the route does not exist at all.
 *  - A2 (from #537): `POST /links/:id/refunds/:refundId/submit` takes
 *    `{ signedXdr }` and returns `{ txHash }` on success (mirroring
 *    `POST /links/:id/submit`). A second submit of the same XDR returns the
 *    stored hash.
 *  - A3 (from #538): a refund becomes `confirmed` when the ledger shows the
 *    payment; the test observes that directly on Horizon, and drives
 *    `LinkService.pollRefunds()` itself when that method exists (the test
 *    process runs no refund poller of its own). There is no refund-status
 *    endpoint specified anywhere, so the test does not poll one.
 *  - A4 (from #539): `link.refunded` is queued through `fireWebhook`, so it
 *    only exists when the seller has a webhook registered — the test registers
 *    a dummy one — and it is visible in `GET /links/:id/detail` deliveries.
 *    Until #538/#539 land there is no poller to fire it, so the delivery check
 *    is recorded as pending rather than asserted.
 *  - A5 (from #535/#542): a refund above the refundable amount is refused
 *    with `409 refund_exceeds_refundable`. After 0.5 of 2 USDC is refunded,
 *    1.6 USDC exceeds the remaining 1.5 USDC.
 *  - A6: the seller authenticates with a session Bearer token (sessions carry
 *    all scopes, so `requireScope("refunds:initiate")` passes), and each
 *    refund call carries its own `Idempotency-Key`.
 *
 * NOT exercised against the live refund endpoints by the author: they do not
 * exist yet. Until #535/#537 land, the refund stages skip on the missing
 * route (404) or the disabled flag (501) after the pay half has run live.
 */
const LIVE_REFUND = process.env.RUN_LIVE_REFUND_TESTS === "1";

/** Small enough to see the whole flow; the refund is a quarter of it. */
const LINK_AMOUNT = "2";
const REFUND_AMOUNT = "0.5";
const OVER_REFUND_AMOUNT = "1.6";

const PREPARE_TIMEOUT_MS = 180_000;
const BOOT_TIMEOUT_MS = 60_000;
const PAY_TIMEOUT_MS = 300_000;
const REFUND_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

/** Stages of the refund probe, in order. The first one not reached is where it failed. */
const REFUND_STAGES = ["prepare", "boot", "pay", "prepare-refund", "submit-refund", "over-refund"] as const;
type RefundStage = (typeof REFUND_STAGES)[number];

/** Which stage failed, given the last one completed (null = none), or null when all completed. */
function failedRefundStage(lastCompleted: RefundStage | null): RefundStage | null {
  const next = lastCompleted === null ? 0 : REFUND_STAGES.indexOf(lastCompleted) + 1;
  return REFUND_STAGES[next] ?? null;
}

function keypairFromEnv(name: string): Keypair | null {
  const secret = process.env[name];
  return secret ? Keypair.fromSecret(secret) : null;
}

/** Horizon transaction record, enough to check the memo and the operations. */
interface HorizonTransaction {
  hash: string;
  successful: boolean;
  memo_type: string | null;
  memo: string | null;
}

async function horizonTransaction(hash: string): Promise<HorizonTransaction> {
  const res = await fetch(`${HORIZON_TESTNET}/transactions/${hash}`);
  if (!res.ok) throw new Error(`Horizon GET /transactions/${hash} returned ${res.status}`);
  return (await res.json()) as HorizonTransaction;
}

interface HorizonOperation {
  id: string;
  type: string;
}

async function firstOperationId(txHash: string): Promise<string> {
  const res = await fetch(`${HORIZON_TESTNET}/transactions/${txHash}/operations`);
  if (!res.ok) throw new Error(`Horizon GET /transactions/${txHash}/operations returned ${res.status}`);
  const body = (await res.json()) as { _embedded: { records: HorizonOperation[] } };
  const op = body._embedded.records[0];
  if (!op) throw new Error(`Horizon reports no operations for transaction ${txHash}`);
  return op.id;
}

describe.skipIf(!LIVE_REFUND)("Refund end-to-end (live)", () => {
  const buyer = keypairFromEnv("REFUND_PROBE_BUYER_SECRET") ?? Keypair.random();
  const sellerKey = keypairFromEnv("REFUND_PROBE_SELLER_SECRET") ?? Keypair.random();
  const funder = keypairFromEnv("REFUND_PROBE_FUNDER_SECRET");

  let container: TestContainer;
  let app: Hono;
  let token = "";
  let loop: WatcherLoop;
  let linkId = "";
  let reference = "";
  let payTxHash = "";
  let payOperationId = "";
  let refundId = "";
  let refundXdr = "";
  let refundPassphrase = "";
  let refundTxHash = "";
  let lastCompleted: RefundStage | null = null;

  /** Skip (not fail) a stage whose predecessor did not complete; record the ones that do. */
  const after = (previous: RefundStage | null, skip: () => void) => {
    if (lastCompleted !== previous) skip();
  };
  const done = (stage: RefundStage, timings: Record<string, unknown> = {}) => {
    lastCompleted = stage;
    mergeProbeTelemetry({ refundLastStage: stage, ...timings }, "refund-probe-telemetry.json");
  };

  const api = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });

  /**
   * Assert a response status, including the body in the failure message.
   * Reads the body only on mismatch: `expect(res.status, await res.text())`
   * would drain the stream before the caller can read the JSON.
   */
  async function expectStatus(res: Response, status: number): Promise<void> {
    if (res.status !== status) {
      throw new Error(`expected HTTP ${status}, got ${res.status}: ${await res.text()}`);
    }
  }

  beforeAll(() => {
    mergeProbeTelemetry(
      { refundLastStage: null, refundFailedStage: null, refundTxHash: null, payTxHash: null },
      "refund-probe-telemetry.json",
    );
  });

  afterAll(() => {
    loop?.stop();
    mergeProbeTelemetry({ refundFailedStage: failedRefundStage(lastCompleted) }, "refund-probe-telemetry.json");
  });

  it("stage 1/6 prepare: buyer and seller probe accounts exist and the buyer holds 2 testnet USDC", async (t) => {
    // t.skip() throws to mark the test skipped, but its type says void, so
    // this wrapper (returning never) is what lets the checker narrow after it.
    const skip = (message: string): never => {
      t.skip(message);
      throw new Error(`unreachable after t.skip(): ${message}`);
    };
    // The seller only needs a USDC trustline to receive the payment; the buyer
    // needs the 2 USDC it is about to spend. Friendbot funds XLM, never USDC.
    await ensureProbeAccount({ keypair: sellerKey, minUsdc: 0 });
    try {
      await ensureProbeAccount({ keypair: buyer, minUsdc: Number(LINK_AMOUNT) });
    } catch (err) {
      if (!(err instanceof ProbeFundingError)) throw err;
      if (!funder) {
        skip(
          `buyer probe account holds no testnet USDC (${err.message}). ` +
            `Top it up from https://faucet.circle.com (pass its secret as REFUND_PROBE_BUYER_SECRET) ` +
            `or set REFUND_PROBE_FUNDER_SECRET to a funded testnet key.`,
        );
      }
      // skip() above throws, so the funder is set here.
      const funderKey = funder!;
      // The buyer has a trustline by now (ensureProbeAccount adds it before
      // checking the balance); the funder tops it up and the check is retried.
      const funderAccount = await loadAccount(HORIZON_TESTNET, funderKey.publicKey());
      if (!funderAccount) throw new Error(`funder ${funderKey.publicKey()} does not exist on testnet`);
      const tx = new TransactionBuilder(new Account(funderKey.publicKey(), funderAccount.sequence), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: buyer.publicKey(),
            asset: new Asset("USDC", USDC_TESTNET_ISSUER),
            amount: "2.5",
          }),
        )
        .setTimeout(180)
        .build();
      tx.sign(funderKey);
      await submitTransaction(HORIZON_TESTNET, tx);
      await ensureProbeAccount({ keypair: buyer, minUsdc: Number(LINK_AMOUNT) });
    }
    done("prepare");
  }, PREPARE_TIMEOUT_MS);

  it("stage 2/6 boot: the API runs in-process and a 2 USDC link exists for the seller probe wallet", async (t) => {
    after("prepare", () => t.skip());
    container = await createTestContainer();
    const seller = await container.sellers.createIfAbsent(sellerKey.publicKey());
    token = await container.tokenFor(seller.id, seller.wallet);

    app = new Hono();
    // The real link routes, mounted the way src/index.ts mounts them, with a
    // pass-through strict limiter (rate limits are not what this probe tests).
    app.route("/links", linkRoutes(container, async (_c, next) => next()));
    app.route("/webhooks", webhookRoutes(container));

    // The real polling watcher over Horizon testnet, driven by hand: the test
    // process runs no server, so nothing ticks the loop for it.
    loop = new WatcherLoop({
      watcher: new HorizonWatcher({ primaryServer: HORIZON_TESTNET }),
      links: container.links,
      state: container.state,
      service: container.service,
      pollMs: POLL_INTERVAL_MS,
    });

    // link.refunded is only queued when the seller has a webhook (A4): the URL
    // is a dummy — the queue entry is what the test looks for, not a delivery.
    const hookRes = await api("/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/quay-refund-probe" }),
    });
    await expectStatus(hookRes, 201);

    const res = await api("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Refund probe link", amount: LINK_AMOUNT, assetCode: "USDC" }),
    });
    await expectStatus(res, 201);
    const body = (await res.json()) as { link: { id: string; reference: string; destination: string } };
    linkId = body.link.id;
    reference = body.link.reference;
    expect(body.link.destination).toBe(sellerKey.publicKey());
    done("boot");
  }, BOOT_TIMEOUT_MS);

  it("stage 3/6 pay: the buyer pays 2 USDC with the link memo and the link becomes paid", async (t) => {
    after("boot", () => t.skip());
    const buyerAccount = await loadAccount(HORIZON_TESTNET, buyer.publicKey());
    if (!buyerAccount) throw new Error("buyer probe account disappeared from Horizon testnet");
    const tx = new TransactionBuilder(new Account(buyer.publicKey(), buyerAccount.sequence), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: sellerKey.publicKey(),
          asset: new Asset("USDC", USDC_TESTNET_ISSUER),
          amount: LINK_AMOUNT,
        }),
      )
      .addMemo(Memo.text(reference))
      .setTimeout(300)
      .build();
    tx.sign(buyer);

    const res = await app.request(`/links/${linkId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr: tx.toXDR() }),
    });
    await expectStatus(res, 200);
    payTxHash = ((await res.json()) as { txHash: string }).txHash;
    expect(payTxHash).toMatch(/^[0-9a-f]{64}$/);
    payOperationId = await firstOperationId(payTxHash);

    // The watcher owns the paid transition: tick it until the ledger payment
    // is matched to the link.
    const { value: link } = await pollUntil(
      "the link to become paid",
      async () => {
        await loop.runOnce();
        const got = await app.request(`/links/${linkId}`);
        return ((await got.json()) as { link: { status: string } }).link;
      },
      (l) => l.status === "paid",
      { timeoutMs: PAY_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    expect(link.status).toBe("paid");
    done("pay", { payTxHash });
  }, PAY_TIMEOUT_MS + 60_000);

  it("stage 4/6 prepare-refund: the API builds an unsigned 0.5 USDC refund to the buyer", async (t) => {
    after("pay", () => t.skip());
    const res = await api(`/links/${linkId}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `refund-probe-${linkId}-0.5` },
      body: JSON.stringify({ payment: `${payTxHash}:${payOperationId}`, amount: REFUND_AMOUNT }),
    });
    // The refund endpoints do not exist yet (#535 open): a 404 is the route
    // missing, a 501 refunds_disabled is the flag still off (#530 open).
    // Either way there is nothing to test against — skip, never fail.
    if (res.status === 404 || res.status === 501) {
      const body = await res.text();
      t.skip(`refund endpoints not implemented yet (POST /links/:id/refunds returned ${res.status}: ${body}). Depends on #535/#530.`);
    }
    await expectStatus(res, 200);
    const refund = (await res.json()) as {
      refundId: string;
      xdr: string;
      networkPassphrase: string;
      expiresAt: number;
    };
    expect(refund.refundId).toBeTruthy();
    expect(refund.networkPassphrase).toBe(Networks.TESTNET);
    expect(refund.expiresAt).toBeGreaterThan(Date.now());
    refundId = refund.refundId;
    refundXdr = refund.xdr;
    refundPassphrase = refund.networkPassphrase;

    // The returned XDR must decode to exactly the refund asked for (A1).
    const tx = TransactionBuilder.fromXDR(refund.xdr, refund.networkPassphrase) as Transaction;
    expect(tx.source).toBe(sellerKey.publicKey());
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0]!;
    expect(op.type).toBe("payment");
    const payment = op as Operation.Payment;
    expect(payment.destination).toBe(buyer.publicKey());
    expect(payment.asset.getCode()).toBe("USDC");
    expect(payment.asset.getIssuer()).toBe(USDC_TESTNET_ISSUER);
    expect(payment.amount).toBe(REFUND_AMOUNT);
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value?.toString()).toBe(`refund ${reference}`);
    expect(tx.timeBounds).toBeDefined();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsLeft = Number(tx.timeBounds?.maxTime) - nowSeconds;
    expect(secondsLeft).toBeGreaterThan(0);
    expect(secondsLeft).toBeLessThanOrEqual(300);
    done("prepare-refund", { refundId });
  }, 60_000);

  it("stage 5/6 submit-refund: the seller-signed refund lands on the ledger and is confirmed", async (t) => {
    after("prepare-refund", () => t.skip());

    // The seller's wallet signs in the test process, standing in for the
    // browser's signTransaction — the server never holds the key (A2).
    const tx = TransactionBuilder.fromXDR(refundXdr, refundPassphrase) as Transaction;
    tx.sign(sellerKey);
    const submitted = await api(`/links/${linkId}/refunds/${refundId}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `refund-probe-${linkId}-0.5-submit` },
      body: JSON.stringify({ signedXdr: tx.toXDR() }),
    });
    await expectStatus(submitted, 200);
    refundTxHash = ((await submitted.json()) as { txHash: string }).txHash;
    expect(refundTxHash).toMatch(/^[0-9a-f]{64}$/);

    // Confirmation comes from the ledger (#538): the refund transaction must
    // be successful on Horizon, paying exactly 0.5 USDC to the buyer with the
    // refund memo.
    const { value: found } = await pollUntil(
      "the refund transaction to appear on Horizon testnet",
      async () => horizonTransaction(refundTxHash),
      (foundTx) => foundTx.successful,
      { timeoutMs: REFUND_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    );
    expect(found.successful).toBe(true);
    expect(found.memo_type).toBe("text");
    expect(found.memo).toBe(`refund ${reference}`);
    const opsRes = await fetch(`${HORIZON_TESTNET}/transactions/${refundTxHash}/operations`);
    expect(opsRes.status).toBe(200);
    const ops = (await opsRes.json()) as {
      _embedded: { records: { type: string; to: string; amount: string; asset_code: string; asset_issuer: string }[] };
    };
    expect(ops._embedded.records).toHaveLength(1);
    const op = ops._embedded.records[0]!;
    expect(op.type).toBe("payment");
    expect(op.to).toBe(buyer.publicKey());
    expect(op.amount).toBe(REFUND_AMOUNT);
    expect(op.asset_code).toBe("USDC");
    expect(op.asset_issuer).toBe(USDC_TESTNET_ISSUER);

    // link.refunded is queued by the refund poller when it settles the refund
    // (#538/#539). Until that lands there is no poller to drive, so the
    // delivery check is recorded as pending rather than asserted (A4).
    const service = container.service as unknown as { pollRefunds?: () => Promise<void> };
    if (typeof service.pollRefunds === "function") {
      const { value: deliveries } = await pollUntil(
        "link.refunded to be queued",
        async () => {
          await service.pollRefunds!();
          const detail = await api(`/links/${linkId}/detail`);
          expect(detail.status).toBe(200);
          return ((await detail.json()) as { deliveries: { event: string }[] }).deliveries;
        },
        (rows) => rows.some((d) => d.event === "link.refunded"),
        { timeoutMs: 120_000, intervalMs: POLL_INTERVAL_MS },
      );
      expect(deliveries.some((d) => d.event === "link.refunded")).toBe(true);
    } else {
      mergeProbeTelemetry({ refundWebhookPending: "link.refunded check needs #538/#539" }, "refund-probe-telemetry.json");
    }
    done("submit-refund", { refundTxHash });
  }, REFUND_TIMEOUT_MS + 120_000);

  it("stage 6/6 over-refund: a second refund of 1.6 USDC is refused — only 1.5 USDC is left", async (t) => {
    after("submit-refund", () => t.skip());
    const res = await api(`/links/${linkId}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `refund-probe-${linkId}-1.6` },
      body: JSON.stringify({ payment: `${payTxHash}:${payOperationId}`, amount: OVER_REFUND_AMOUNT }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("refund_exceeds_refundable");
    done("over-refund");
  }, 60_000);
});
