import { describe, expect, it } from "vitest";
import { AnchorAuthRequiredError, OffRampJobNotFoundError, type AnchorCustomer, type KycPort, type OffRampInitiation, type RailPort, type WithdrawTransfer } from "@checkout/core";
import { MockAnchorOffRamp, Sep6ValidationError } from "@checkout/offramp";
import type { StellarConfig } from "@checkout/stellar";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedKyc,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

/** OffRampInitiation with optional transfer for testing. */
type TestInitiation = OffRampInitiation & { transfer?: WithdrawTransfer };

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const UNUSED_RAIL: RailPort = {
  async assertCanReceive() {},
  buildRequest() {
    throw new Error("not used in these tests");
  },
  isValidDestination() {
    return true;
  },
};

function makeService(opts: {
  links: FakeLinkRepository;
  offramp: ScriptedOffRamp | MockAnchorOffRamp;
  offrampState: FakeOffRampStateRepository;
  webhooks?: FakeWebhookRepository;
  kyc?: KycPort;
  telemetry?: FakeTelemetryRepository;
  interactiveTimeoutMs?: number;
}): LinkService {
  return new LinkService({
    links: opts.links,
    sellers: {
      findById: async (id) =>
        id === "sel_1" ? { id: "sel_1", name: "Seller", wallet: "GSELLER", profileKind: "individual", payoutFields: null, createdAt: 0 } : null,
      findByWallet: async () => null,
      createIfAbsent: async () => ({ id: "sel_1", name: "Seller", wallet: "GSELLER", profileKind: "individual", payoutFields: null, createdAt: 0 }),
      savePayoutFields: async () => {},
      saveProfileKind: async () => {},
    },
    webhooks: opts.webhooks ?? new FakeWebhookRepository(),
    rail: UNUSED_RAIL,
    offramp: opts.offramp,
    offrampState: opts.offrampState,
    kyc: opts.kyc ?? new AlwaysAcceptedKyc(),
    stellar: STELLAR,
    telemetry: opts.telemetry ?? new FakeTelemetryRepository(),
    correlation: "memo",
    webhookGuard: async () => ({ ok: true }) as const,
    ...(opts.interactiveTimeoutMs !== undefined
      ? { interactiveTimeoutMs: opts.interactiveTimeoutMs }
      : {}),
  });
}

describe("LinkService.pollCashOuts", () => {
  it("settles a link when the adapter reports settled", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "settled",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_settled");
    expect(links.get("lnk_1")?.offrampStatus).toBe("settled");
  });

  it("writes a settled telemetry row whose effective_rate comes from the anchor-reported amount_out, not the quote", async () => {
    const links = new FakeLinkRepository([
      makeLink({
        status: "offramp_pending",
        offrampJobId: "job_1",
        offrampStatus: "pending",
        paidAmount: "10",
      }),
    ]);
    // The anchor quotes rate 1650 (implied target 16500) but reports settling at
    // 16350 — a 150-unit fee. effective_rate must read 1635, NOT 1650, or the
    // spread column silently reads zero forever.
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "settled",
      targetCurrency: "NGN",
      targetAmount: "16350",
      rate: "1650",
    });
    const telemetry = new FakeTelemetryRepository();

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository(), telemetry }).pollCashOuts();

    const settled = telemetry.rows.find((r) => r.id === "tel_job_1");
    expect(settled?.status).toBe("settled");
    expect(settled?.quotedRate).toBe("1650");
    expect(settled?.effectiveRate).toBe("1635");
    expect(settled?.feeAmount).toBe("150.000000");
  });

  it("moves the link to offramp_failed when status() throws a typed OffRampJobNotFoundError", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_lost", offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => {
      throw new OffRampJobNotFoundError(jobId);
    };

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
    expect(links.get("lnk_1")?.offrampStatus).toBe("failed");
  });

  it("leaves the link pending on a transient (non-typed) error, to retry next tick", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async () => {
      throw new Error("ECONNRESET");
    };

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("fails a link stuck at offramp_pending with no job id at all (can never resolve)", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: null, offrampStatus: "pending" }),
    ]);
    const offramp = new ScriptedOffRamp();

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
  });

  it("updates offrampStatus from awaiting_transfer to pending when anchor moves to pending", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "awaiting_transfer" }),
    ]);
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    await makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
    expect(links.get("lnk_1")?.offrampStatus).toBe("pending");
  });

  it("fails an incomplete job past the interactive timeout and fires offramp.failed", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_stuck", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_stuck",
      linkId: "lnk_1",
      anchor: "testanchor",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: "incomplete",
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now() - 2 * 3_600_000,
      updatedAt: Date.now(),
    });
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });
    const webhooks = new FakeWebhookRepository();
    await webhooks.create({ sellerId: "sel_1", url: "https://example.com/h", secret: "test-secret" });

    await makeService({ links, offramp, offrampState, webhooks }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
    expect(links.get("lnk_1")?.offrampStatus).toBe("failed");
    const failed = webhooks.queue.map((row) => JSON.parse(row.payload) as { event: string; data: { reason?: string } });
    expect(failed.some((e) => e.event === "offramp.failed" && e.data.reason === "interactive_abandoned")).toBe(true);
  });

  it("leaves a recently-incomplete job pending", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_fresh", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_fresh",
      linkId: "lnk_1",
      anchor: "testanchor",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: "incomplete",
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    await makeService({ links, offramp, offrampState }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("honors a custom interactiveTimeoutMs", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_custom", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_custom",
      linkId: "lnk_1",
      anchor: "testanchor",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: "incomplete",
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now() - 2_000,
      updatedAt: Date.now(),
    });
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    await makeService({ links, offramp, offrampState, interactiveTimeoutMs: 1_000 }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
  });

  it("leaves a stale non-incomplete job pending", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_old", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_old",
      linkId: "lnk_1",
      anchor: "testanchor",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: "pending_anchor",
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now() - 2 * 3_600_000,
      updatedAt: Date.now(),
    });
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId,
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    await makeService({ links, offramp, offrampState }).pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });
});

describe("LinkService.backfillLostOffRampJobs", () => {
  it("fails a link whose job id has no row in the off-ramp state store", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_never_persisted", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState });

    const fixed = await service.backfillLostOffRampJobs();

    expect(fixed).toBe(1);
    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
    expect(links.get("lnk_1")?.offrampStatus).toBe("failed");
  });

  it("leaves a link alone when its job row is present", async () => {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "job_1", offrampStatus: "pending" }),
    ]);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_1",
      linkId: "lnk_1",
      anchor: "mock",
      sellerId: null,
      account: null,
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState });

    const fixed = await service.backfillLostOffRampJobs();

    expect(fixed).toBe(0);
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("does not touch links that aren't offramp_pending", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState: new FakeOffRampStateRepository() });

    const fixed = await service.backfillLostOffRampJobs();

    expect(fixed).toBe(0);
    expect(links.get("lnk_1")?.status).toBe("paid");
  });
});

describe("LinkService.triggerCashOut — KYC gate", () => {
  it("rejects with 403 kyc_required when the seller's KYC isn't ACCEPTED", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const kyc = new ScriptedKyc();
    kyc.statusImpl = async ({ sellerId, account }) => ({
      sellerId,
      anchorDomain: "testanchor.stellar.org",
      account,
      customerId: null,
      status: "NEEDS_INFO",
      requiredFields: [],
      providedFields: {},
      providedFieldStatus: [],
      sentFields: [],
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    });
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState: new FakeOffRampStateRepository(), kyc });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
    ).rejects.toMatchObject({ status: 403, message: "kyc_required" });
    // Never reached the off-ramp adapter, and the link stays untouched.
    expect(links.get("lnk_1")?.status).toBe("paid");
  });

  it("proceeds to the off-ramp adapter once KYC is ACCEPTED", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 60_000 });
    const service = makeService({ links, offramp, offrampState, kyc: new AlwaysAcceptedKyc() });

    const { job } = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(job.status).toBe("pending");
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });
});

describe("LinkService + MockAnchorOffRamp — restart survives (integration)", () => {
  it("a cash-out initiated pre-restart still settles once a fresh service/adapter pair polls it", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();

    // "Pre-restart" process: trigger the cash-out.
    const preRestartOfframp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 0 });
    const preRestartService = makeService({ links, offramp: preRestartOfframp, offrampState });
    const { job } = await preRestartService.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
    expect(links.get("lnk_1")?.offrampJobId).toBe(job.jobId);

    // "Restart": brand-new adapter and service instances. Only `links` and
    // `offrampState` — the two persisted stores — carry over.
    const postRestartOfframp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 0 });
    const postRestartService = makeService({ links, offramp: postRestartOfframp, offrampState });
    await postRestartService.pollCashOuts();

    expect(links.get("lnk_1")?.status).toBe("offramp_settled");
    expect(links.get("lnk_1")?.offrampStatus).toBe("settled");
  });
});

describe("LinkService.triggerCashOut — discriminated union return", () => {
  it("moves link to offramp_pending for fields initiation arm", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state: offrampState });
    const service = makeService({ links, offramp, offrampState });

    const { job, initiation } = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(initiation.kind).toBe("fields");
    if (initiation.kind === "fields") {
      expect(initiation.jobId).toBe(job.jobId);
    }
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("moves link to offramp_pending for interactive initiation arm", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async (input) => ({
      quoteId: "q_1",
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: "1650.00",
      rate: "1650",
      expiresAt: Date.now() + 60_000,
      fee: { amount: "16.50", currency: input.targetCurrency, source: "anchor" },
      netTargetAmount: "1633.50",
    });
    offramp.initiateImpl = async () => ({
      kind: "interactive",
      jobId: "job_interactive_123",
      url: "https://anchor.example.com/interactive?id=job_interactive_123",
    });

    const service = makeService({ links, offramp, offrampState });
    const { job, initiation } = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(initiation.kind).toBe("interactive");
    if (initiation.kind === "interactive") {
      expect(initiation.url).toBe("https://anchor.example.com/interactive?id=job_interactive_123");
      expect(initiation.jobId).toBe("job_interactive_123");
    }
    expect(job.jobId).toBe("job_interactive_123");
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
    expect(links.get("lnk_1")?.offrampJobId).toBe("job_interactive_123");
  });

  it("moves link to offramp_pending with offrampStatus awaiting_transfer for transfer initiation arm", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async (input) => ({
      quoteId: "q_1",
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: "1650.00",
      rate: "1650",
      expiresAt: Date.now() + 60_000,
      fee: { amount: "16.50", currency: input.targetCurrency, source: "anchor" },
      netTargetAmount: "1633.50",
    });
    offramp.initiateImpl = async () => ({
      kind: "transfer",
      jobId: "job_transfer_123",
      transfer: {
        destination: "GANCHOR_ACCOUNT",
        amount: "10",
        asset: { code: "USDC", issuer: "GUSDC" },
        memo: "12345",
        memoType: "id",
      },
    });

    const service = makeService({ links, offramp, offrampState });
    const { job, initiation } = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(initiation.kind).toBe("transfer");
    expect(job.jobId).toBe("job_transfer_123");
    expect(job.status).toBe("awaiting_transfer");
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
    expect(links.get("lnk_1")?.offrampStatus).toBe("awaiting_transfer");
  });
});

// The route flattens the union into `{ job, interactiveUrl? }` (issue 1.1
// item 5). Pinning it here rather than only in the service: the flattening is
// the public API contract a SEP-24 adapter and the dashboard both code
// against, and `initiation.kind === "interactive" ? initiation.url : undefined`
// is exactly the kind of line a later refactor gets subtly wrong.
describe("cash-out response flattening", () => {
  function flatten(initiation: OffRampInitiation): string | undefined {
    return initiation.kind === "interactive" ? initiation.url : undefined;
  }

  it("omits interactiveUrl for a field-driven initiation", () => {
    expect(flatten({ kind: "fields", jobId: "ofr_1" })).toBeUndefined();
  });

  it("surfaces the anchor url for an interactive initiation", () => {
    expect(
      flatten({ kind: "interactive", jobId: "ofr_1", url: "https://anchor.example.com/sep24" }),
    ).toBe("https://anchor.example.com/sep24");
  });
});

describe("LinkService.triggerCashOut — quoteId handling", () => {
  it("initiates against the exact quote without calling offramp.quote when quoteId is provided", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid", amount: "10" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new ScriptedOffRamp();
    let quoteCalled = false;
    offramp.quoteImpl = async () => {
      quoteCalled = true;
      throw new Error("offramp.quote should not have been called!");
    };
    let initiatedQuoteId = "";
    offramp.initiateImpl = async (input) => {
      initiatedQuoteId = input.quoteId;
      return { kind: "fields", jobId: "job_from_quote_123" };
    };

    const now = Date.now();
    await offrampState.saveQuote({
      quoteId: "quote_valid_123",
      linkId: "lnk_1",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "10",
      buyCurrency: "NGN",
      price: "1650",
      quotedAmounts: {
        rate: "1650",
        targetAmount: "16400.00",
        feeAmount: "165.00",
        feeSource: "anchor",
        netTargetAmount: "16335.00",
      },
      expiresAt: now + 60_000,
      createdAt: now,
    });

    const service = makeService({ links, offramp, offrampState });
    const { job, initiation } = await service.triggerCashOut("lnk_1", {
      targetCurrency: "NGN",
      payoutFields: {},
      quoteId: "quote_valid_123",
    });

    expect(quoteCalled).toBe(false);
    expect(initiatedQuoteId).toBe("quote_valid_123");
    expect(initiation.kind).toBe("fields");
    expect(job.jobId).toBe("job_from_quote_123");
    expect(job.targetCurrency).toBe("NGN");
    expect(job.rate).toBe("1650");
    // The job carries the figures the seller was shown, not a recomputation.
    expect(job.targetAmount).toBe("16400.00");

    const savedLink = links.get("lnk_1");
    expect(savedLink?.status).toBe("offramp_pending");
    expect(savedLink?.offrampRate).toBe("1650");
    expect(savedLink?.offrampTargetCurrency).toBe("NGN");
  });

  it("rejects with 409 quote_mismatch when quoteId does not exist", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new ScriptedOffRamp();
    const service = makeService({ links, offramp, offrampState });

    await expect(
      service.triggerCashOut("lnk_1", {
        targetCurrency: "NGN",
        payoutFields: {},
        quoteId: "quote_nonexistent",
      }),
    ).rejects.toMatchObject({ status: 409, message: "quote_mismatch" });
  });

  it("rejects with 409 quote_mismatch when quoteId belongs to a different link", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const now = Date.now();
    await offrampState.saveQuote({
      quoteId: "quote_other_link",
      linkId: "lnk_2",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "10",
      buyCurrency: "NGN",
      price: "1650",
      expiresAt: now + 60_000,
      createdAt: now,
    });
    const offramp = new ScriptedOffRamp();
    const service = makeService({ links, offramp, offrampState });

    await expect(
      service.triggerCashOut("lnk_1", {
        targetCurrency: "NGN",
        payoutFields: {},
        quoteId: "quote_other_link",
      }),
    ).rejects.toMatchObject({ status: 409, message: "quote_mismatch" });
  });

  it("rejects with 409 quote_mismatch when quote target currency does not match requested currency", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const now = Date.now();
    await offrampState.saveQuote({
      quoteId: "quote_usd",
      linkId: "lnk_1",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "10",
      buyCurrency: "USD",
      price: "1",
      expiresAt: now + 60_000,
      createdAt: now,
    });
    const offramp = new ScriptedOffRamp();
    const service = makeService({ links, offramp, offrampState });

    await expect(
      service.triggerCashOut("lnk_1", {
        targetCurrency: "NGN",
        payoutFields: {},
        quoteId: "quote_usd",
      }),
    ).rejects.toMatchObject({ status: 409, message: "quote_mismatch" });
  });

  it("rejects with 409 quote_expired when quoteId is expired", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const now = Date.now();
    await offrampState.saveQuote({
      quoteId: "quote_expired_1",
      linkId: "lnk_1",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "10",
      buyCurrency: "NGN",
      price: "1650",
      expiresAt: now - 10_000,
      createdAt: now - 70_000,
    });
    const offramp = new ScriptedOffRamp();
    const service = makeService({ links, offramp, offrampState });

    await expect(
      service.triggerCashOut("lnk_1", {
        targetCurrency: "NGN",
        payoutFields: {},
        quoteId: "quote_expired_1",
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("quote_expired") });
  });
});

describe("LinkService cash-out — the seller is the anchor's customer", () => {
  it("asks the anchor about the seller's own wallet, not a platform account", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const seen: AnchorCustomer[] = [];
    const kyc = new ScriptedKyc();
    kyc.statusImpl = async (customer) => {
      seen.push(customer);
      return new AlwaysAcceptedKyc().status(customer);
    };
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 60_000 });
    const service = makeService({ links, offramp, offrampState, kyc });

    await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(seen).toEqual([{ sellerId: "sel_1", account: "GSELLER" }]);
    const job = await offrampState.getJob(links.get("lnk_1")!.offrampJobId!);
    expect(job).toMatchObject({ sellerId: "sel_1", account: "GSELLER" });
  });

  it("answers 403 anchor_auth_required when the seller has not signed in to the anchor", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const kyc = new ScriptedKyc();
    kyc.statusImpl = async () => {
      throw new AnchorAuthRequiredError("anchor.example");
    };
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState: new FakeOffRampStateRepository(), kyc });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
    ).rejects.toMatchObject({ status: 403, message: "anchor_auth_required" });
    await expect(service.quoteCashOut("lnk_1", "NGN")).rejects.toMatchObject({
      status: 403,
      message: "anchor_auth_required",
    });
    expect(links.get("lnk_1")?.status).toBe("paid");
  });

  it("maps an expired anchor session during the quote to 403, not a 502 anchor error", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async () => {
      throw new AnchorAuthRequiredError("anchor.example");
    };
    const service = makeService({ links, offramp, offrampState: new FakeOffRampStateRepository() });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
    ).rejects.toMatchObject({ status: 403, message: "anchor_auth_required" });
  });
});

describe("offramp.transfer_required webhook (4.22)", () => {
  const transfer: WithdrawTransfer = {
    destination: "GANCHOR...",
    amount: "10.50",
    asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    memo: "withdrawal_123",
    memoType: "text",
  };

  function setupWebhooks(webhooks: FakeWebhookRepository): void {
    // Create a webhook for the test seller
    webhooks.hooks.push({
      id: "whk_test",
      sellerId: "sel_1",
      url: "https://example.com/webhook",
      secretEncrypted: "encrypted",
      secretLast4: "abcd",
      previousSecretEncrypted: null,
      previousSecretLast4: null,
      previousSecretExpiresAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    });
  }

  it("emits offramp.transfer_required when initiate returns kind: transfer", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const webhooks = new FakeWebhookRepository();
    setupWebhooks(webhooks);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async () => ({
      quoteId: "quote_1",
      sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sourceAmount: "10",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      expiresAt: Date.now() + 300000,
      fee: { amount: "0", currency: "NGN", source: "estimated" },
      netTargetAmount: "16500",
    });
    offramp.initiateImpl = async () => ({ kind: "transfer", jobId: "job_1", transfer });

    const service = makeService({ links, offramp, offrampState, webhooks });

    const result = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    expect(result.initiation.kind).toBe("transfer");
    expect((result.initiation as TestInitiation).transfer).toEqual(transfer);

    // Webhook should be enqueued
    const enqueued = webhooks.getEnqueued();
    expect(enqueued).toHaveLength(1);
    const entry = enqueued[0]!;
    const payload = JSON.parse(entry.payload);
    expect(payload.event).toBe("offramp.transfer_required");
    expect(payload.data.transfer).toEqual(transfer);
    expect(payload.data.jobId).toBe("job_1");
    expect(payload.data.linkId).toBe("lnk_1");

    // Job should be marked as notified
    const job = await offrampState.getJob("job_1");
    expect(job?.transferNotifiedAt).not.toBeNull();
  });

  it("does not emit offramp.transfer_required when initiate returns kind: fields", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const webhooks = new FakeWebhookRepository();
    setupWebhooks(webhooks);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async () => ({
      quoteId: "quote_1",
      sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sourceAmount: "10",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      expiresAt: Date.now() + 300000,
      fee: { amount: "0", currency: "NGN", source: "estimated" },
      netTargetAmount: "16500",
    });
    offramp.initiateImpl = async () => ({ kind: "fields", jobId: "job_1" });

    const service = makeService({ links, offramp, offrampState, webhooks });

    await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });

    const enqueued = webhooks.getEnqueued();
    expect(enqueued).toHaveLength(0);
  });

  it("emits offramp.transfer_required on first poll when status returns transfer", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "offramp_pending", offrampJobId: "job_1" })]);
    const webhooks = new FakeWebhookRepository();
    setupWebhooks(webhooks);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_1",
      linkId: "lnk_1",
      anchor: "mock",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async () => ({
      jobId: "job_1",
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      transfer,
    });

    const service = makeService({ links, offramp, offrampState, webhooks });

    await service.pollCashOuts();

    // Webhook should be enqueued
    const enqueued = webhooks.getEnqueued();
    expect(enqueued).toHaveLength(1);
    const entry = enqueued[0]!;
    const payload = JSON.parse(entry.payload);
    expect(payload.event).toBe("offramp.transfer_required");
    expect(payload.data.transfer).toEqual(transfer);
    expect(payload.data.jobId).toBe("job_1");
    expect(payload.data.linkId).toBe("lnk_1");

    // Job should be marked as notified
    const job = await offrampState.getJob("job_1");
    expect(job?.transferNotifiedAt).not.toBeNull();
  });

  it("does not re-emit offramp.transfer_required on subsequent polls", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "offramp_pending", offrampJobId: "job_1" })]);
    const webhooks = new FakeWebhookRepository();
    setupWebhooks(webhooks);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_1",
      linkId: "lnk_1",
      anchor: "mock",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: Date.now(), // already notified
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async () => ({
      jobId: "job_1",
      linkId: "lnk_1",
      status: "pending",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      transfer,
    });

    const service = makeService({ links, offramp, offrampState, webhooks });

    await service.pollCashOuts();
    await service.pollCashOuts(); // second poll

    // Webhook should only be enqueued once
    const enqueued = webhooks.getEnqueued();
    expect(enqueued).toHaveLength(0);
  });

  it("does not emit offramp.transfer_required when job status is settled", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "offramp_pending", offrampJobId: "job_1" })]);
    const webhooks = new FakeWebhookRepository();
    setupWebhooks(webhooks);
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob({
      jobId: "job_1",
      linkId: "lnk_1",
      anchor: "mock",
      sellerId: "sel_1",
      account: "GSELLER",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async () => ({
      jobId: "job_1",
      linkId: "lnk_1",
      status: "settled",
      targetCurrency: "NGN",
      targetAmount: "16500",
      rate: "1650",
    });

    const service = makeService({ links, offramp, offrampState, webhooks });

    await service.pollCashOuts();

    // Should emit offramp.settled, not offramp.transfer_required
    const enqueued = webhooks.getEnqueued();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.event).toBe("offramp.settled");
  });
});

describe("LinkService cash-out retry from offramp_failed", () => {
  const stale = {
    offrampJobId: "job_old",
    offrampStatus: "failed" as const,
    offrampRate: "1500",
    offrampRateDelta: "0.5",
    offrampFeeAmount: "9",
    offrampFeeCurrency: "NGN",
    offrampFeeSource: "estimated" as const,
    offrampNetTargetAmount: "14991",
  };

  async function failedSetup(previousStatus: "failed" | "pending" | null, alwaysFail = false) {
    const links = new FakeLinkRepository([makeLink({ status: "offramp_failed", ...stale })]);
    const offrampState = new FakeOffRampStateRepository();
    if (previousStatus) {
      await offrampState.saveJob({
        jobId: "job_old",
        linkId: "lnk_1",
        anchor: "mock",
        sellerId: "sel_1",
        account: null,
        targetCurrency: "NGN",
        targetAmount: "1",
        rate: "1",
        status: previousStatus,
        externalStatus: null,
        lastError: null,
        transferNotifiedAt: null,
        createdAt: 0,
        updatedAt: 0,
      } as never);
    }
    const offramp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 60_000, alwaysFail });
    return { links, service: makeService({ links, offramp, offrampState }) };
  }

  it("quotes and cashes out again after a failure, moving the link to offramp_pending", async () => {
    const { links, service } = await failedSetup("failed");
    const quote = await service.quoteCashOut("lnk_1", "NGN");
    expect(quote.targetCurrency).toBe("NGN");

    const { job } = await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });
    const link = links.get("lnk_1")!;
    expect(link.status).toBe("offramp_pending");
    expect(link.offrampJobId).toBe(job.jobId);
    expect(link.offrampJobId).not.toBe("job_old");
    // Per-attempt fields describe the new attempt, not the failed one.
    expect(link.offrampRate).not.toBe("1500");
    expect(link.offrampRateDelta).not.toBe("0.5");
    expect(link.offrampFeeAmount).not.toBe("9");
    expect(link.offrampNetTargetAmount).not.toBe("14991");
  });

  it("allows a retry when the previous job's state is gone (job_state_lost)", async () => {
    const { links, service } = await failedSetup(null);
    await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("refuses a retry while the previous job is still pending at the anchor", async () => {
    const { links, service } = await failedSetup("pending");
    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
    ).rejects.toMatchObject({ status: 409, message: "previous_withdrawal_active" });
    expect(links.get("lnk_1")?.status).toBe("offramp_failed");
    expect(links.get("lnk_1")?.offrampJobId).toBe("job_old");
  });

  it("a failing anchor fails the retry again and it can be retried once more", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const offrampState = new FakeOffRampStateRepository();
    const offramp = new MockAnchorOffRamp({ state: offrampState, settleAfterMs: 0, alwaysFail: true });
    const service = makeService({ links, offramp, offrampState });

    await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });
    await service.pollCashOuts();
    expect(links.get("lnk_1")?.status).toBe("offramp_failed");

    await service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} });
    expect(links.get("lnk_1")?.status).toBe("offramp_pending");
  });

  it("still refuses offramp_settled and links that are not paid", async () => {
    for (const status of ["offramp_settled", "offramp_pending", "active"] as const) {
      const links = new FakeLinkRepository([makeLink({ status })]);
      const offrampState = new FakeOffRampStateRepository();
      const service = makeService({ links, offramp: new MockAnchorOffRamp({ state: offrampState }), offrampState });
      await expect(service.quoteCashOut("lnk_1", "NGN")).rejects.toMatchObject({ status: 409 });
      await expect(
        service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
      ).rejects.toMatchObject({ status: 409 });
    }
  });
});

describe("LinkService cash-out — anchor rejections", () => {
  function rejecting(): ScriptedOffRamp {
    const offramp = new ScriptedOffRamp();
    offramp.quoteImpl = async () => {
      throw new Sep6ValidationError("above max", { minAmount: 1, maxAmount: 10 }, ["bank_account"]);
    };
    return offramp;
  }

  it("quoteCashOut maps an out-of-range amount to 422 offramp_rejected with limits", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const service = makeService({ links, offramp: rejecting(), offrampState: new FakeOffRampStateRepository() });
    await expect(service.quoteCashOut("lnk_1", "NGN")).rejects.toMatchObject({
      status: 422,
      message: "offramp_rejected",
      extra: { limits: { minAmount: 1, maxAmount: 10 }, availableTypes: ["bank_account"] },
    });
  });

  it("triggerCashOut maps it the same way and leaves the link paid", async () => {
    const links = new FakeLinkRepository([makeLink({ status: "paid" })]);
    const service = makeService({ links, offramp: rejecting(), offrampState: new FakeOffRampStateRepository() });
    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {} }),
    ).rejects.toMatchObject({ status: 422, message: "offramp_rejected", extra: { limits: { maxAmount: 10 } } });
    expect(links.get("lnk_1")?.status).toBe("paid");
  });

  it("rejects with 409 quote_mismatch for a quote saved without its quoted amounts", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid", amount: "10" })]);
    const offrampState = new FakeOffRampStateRepository();
    const now = Date.now();
    await offrampState.saveQuote({
      quoteId: "quote_legacy",
      linkId: "lnk_1",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "10",
      buyCurrency: "NGN",
      price: "1650",
      expiresAt: now + 60_000,
      createdAt: now,
    });
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {}, quoteId: "quote_legacy" }),
    ).rejects.toMatchObject({ status: 409, message: "quote_mismatch" });
  });

  it("rejects with 409 quote_mismatch when the quoted sell amount is not what the link holds", async () => {
    const links = new FakeLinkRepository([makeLink({ id: "lnk_1", status: "paid", amount: "10" })]);
    const offrampState = new FakeOffRampStateRepository();
    const now = Date.now();
    await offrampState.saveQuote({
      quoteId: "quote_other_amount",
      linkId: "lnk_1",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "5",
      buyCurrency: "NGN",
      price: "1650",
      quotedAmounts: {
        rate: "1650",
        targetAmount: "8250.00",
        feeAmount: "0",
        feeSource: "anchor",
        netTargetAmount: "8250.00",
      },
      expiresAt: now + 60_000,
      createdAt: now,
    });
    const service = makeService({ links, offramp: new ScriptedOffRamp(), offrampState });

    await expect(
      service.triggerCashOut("lnk_1", { targetCurrency: "NGN", payoutFields: {}, quoteId: "quote_other_amount" }),
    ).rejects.toMatchObject({ status: 409, message: "quote_mismatch" });
  });
});
