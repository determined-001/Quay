import { Keypair } from "@stellar/stellar-sdk";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OffRampJobNotFoundError, type AnchorCustomer, type Logger } from "@checkout/core";
import { AnchorTimeoutError } from "../src/http";
import { SEP6_STATUS_MAP, TESTANCHOR_BASE_URL, TESTANCHOR_HOME_DOMAIN, TestAnchorOffRamp } from "../src/testanchor";
import { FakeOffRampStateRepository } from "./fake-state";
import {
  USDC_TESTNET_ISSUER,
  anchorWiring,
  makeProbeKeypair as makeKeypair,
  mergeProbeTelemetry,
  signedInAs as signedIn,
} from "./live-probe";

// These hit the real https://testanchor.stellar.org sandbox. Off by default —
// it's a shared external service, not something CI should depend on. Run with:
//   RUN_LIVE_ANCHOR_TESTS=1 pnpm --filter @checkout/offramp test
//
// In CI (or locally) you can supply a specific funded testnet keypair via
//   SELLER_SECRET_KEY=<secret>  — otherwise a random keypair is used.
const ANCHOR_BASE_URL = TESTANCHOR_BASE_URL;

/** The withdraw type the live suite cashes out through. */
export const LIVE_WITHDRAW_TYPE = process.env.OFFRAMP_TYPE ?? "bank_account";

function makeOffRamp(state = new FakeOffRampStateRepository(), wiring = anchorWiring()) {
  // testanchor offers more than one USDC withdraw type; the adapter refuses to
  // guess. anchor-probe.yml sets OFFRAMP_TYPE, so honour it here.
  return new TestAnchorOffRamp({ ...wiring, state, preferredWithdrawType: LIVE_WITHDRAW_TYPE });
}

const OFFLINE_CUSTOMER: AnchorCustomer = { sellerId: "sel_1", account: Keypair.random().publicKey() };

async function makeStatusFixture(logger?: Logger) {
  const state = new FakeOffRampStateRepository();
  const wiring = anchorWiring();
  const now = Date.now();
  await wiring.sessions.save({
    sellerId: OFFLINE_CUSTOMER.sellerId,
    anchorDomain: TESTANCHOR_HOME_DOMAIN,
    account: OFFLINE_CUSTOMER.account,
    token: "offline-jwt",
    expiresAt: now + 60 * 60_000,
    createdAt: now,
  });
  await state.saveJob({
    jobId: "t1",
    linkId: "lnk_1",
    anchor: TESTANCHOR_HOME_DOMAIN,
    sellerId: OFFLINE_CUSTOMER.sellerId,
    account: OFFLINE_CUSTOMER.account,
    targetCurrency: "USD",
    targetAmount: "10",
    rate: "1",
    status: "pending",
    externalStatus: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    transferNotifiedAt: null,
  });
  const offramp = new TestAnchorOffRamp({
    ...wiring,
    state,
    preferredWithdrawType: "bank_account",
    ...(logger ? { logger } : {}),
  });
  return { state, offramp };
}

function stubTransaction(status: string, message?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes(".well-known/stellar.toml")) return new Response("", { status: 500 });
      return Response.json({ transaction: { id: "t1", status, message } });
    }),
  );
}

describe("TestAnchorOffRamp (offline)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exports an explicit mapping for every SEP-6 transaction status", () => {
    expect(Object.keys(SEP6_STATUS_MAP).sort()).toEqual(
      [
        "completed",
        "error",
        "expired",
        "incomplete",
        "no_market",
        "on_hold",
        "pending_anchor",
        "pending_customer_info_update",
        "pending_external",
        "pending_stellar",
        "pending_transaction_info_update",
        "pending_trust",
        "pending_user",
        "pending_user_transfer_complete",
        "pending_user_transfer_start",
        "refunded",
        "too_large",
        "too_small",
      ].sort(),
    );
  });

  it("quote() rejects native XLM with a clear error before any network call", async () => {
    const offramp = makeOffRamp();
    await expect(
      offramp.quote({
        linkId: "lnk_1",
        sourceAsset: { code: "XLM", issuer: null },
        sourceAmount: "25",
        targetCurrency: "USD",
        customer: OFFLINE_CUSTOMER,
      }),
    ).rejects.toThrow(/only off-ramps USDC/);
  });

  it("status() throws a typed OffRampJobNotFoundError for an unknown job id, not an anonymous Error", async () => {
    const offramp = makeOffRamp();
    await expect(offramp.status("no-such-job")).rejects.toBeInstanceOf(OffRampJobNotFoundError);
  });

  it.each([
    ["no_market", "no market for the asset pair (no_market)"],
    ["too_small", "amount below the anchor's limit (too_small)"],
    ["too_large", "amount above the anchor's limit (too_large)"],
  ])("status() maps %s to failed with a reason", async (externalStatus, expectedReason) => {
    stubTransaction(externalStatus);
    const { state, offramp } = await makeStatusFixture();

    const result = await offramp.status("t1");

    expect(result.status).toBe("failed");
    expect(result.reason).toBe(expectedReason);
    expect(await state.getJob("t1")).toMatchObject({ externalStatus, lastError: expectedReason });
  });

  it("status() prefers the anchor message for a failed transaction reason", async () => {
    stubTransaction("too_large", "maximum withdrawal amount is 20 USD");
    const { offramp } = await makeStatusFixture();

    await expect(offramp.status("t1")).resolves.toMatchObject({
      status: "failed",
      reason: "maximum withdrawal amount is 20 USD",
    });
  });

  it.each(["pending_customer_info_update", "pending_transaction_info_update"])(
    "status() marks %s as waiting on the seller without failing",
    async (externalStatus) => {
      stubTransaction(externalStatus);
      const { state, offramp } = await makeStatusFixture();

      const result = await offramp.status("t1");

      expect(result).toMatchObject({ status: "pending", needsSellerAction: true });
      expect(await state.getJob("t1")).toMatchObject({ status: "pending", externalStatus });
    },
  );

  it("logs an unknown SEP-6 status only once per job", async () => {
    stubTransaction("future_status");
    const warn = vi.fn();
    const logger: Logger = {
      child: () => logger,
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    };
    const { offramp } = await makeStatusFixture(logger);

    await offramp.status("t1");
    await offramp.status("t1");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { event: "anchor.sep6.status.unknown", status: "future_status" },
      "unknown SEP-6 transaction status",
    );
  });

  it("initiate() aborts and throws AnchorTimeoutError when anchor withdraw stalls", async () => {
    const state = new FakeOffRampStateRepository();
    const wiring = anchorWiring();
    const now = Date.now();

    await wiring.sessions.save({
      sellerId: OFFLINE_CUSTOMER.sellerId,
      anchorDomain: TESTANCHOR_HOME_DOMAIN,
      account: OFFLINE_CUSTOMER.account,
      token: "offline-jwt",
      expiresAt: now + 60 * 60_000,
      createdAt: now,
    });

    await state.saveQuote({
      quoteId: "q1",
      linkId: "lnk_1",
      sellAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sellAmount: "10",
      buyCurrency: "USD",
      price: "1",
      withdrawType: "bank_account",
      expiresAt: now + 60_000,
      createdAt: now,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(input);
        if (urlStr.includes(".well-known/stellar.toml")) {
          return new Response("", { status: 500 }); // triggers fallback discovery
        }
        if (urlStr.includes("/info")) {
          return new Response(
            JSON.stringify({
              withdraw: {
                USDC: {
                  enabled: true,
                  types: { bank_account: { fields: {} } },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (urlStr.includes("/withdraw")) {
          // Trigger the timeout error that anchorFetch produces
          return Promise.reject(new AnchorTimeoutError(urlStr, 10_000));
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const offramp = new TestAnchorOffRamp({
      ...wiring,
      state,
      preferredWithdrawType: "bank_account",
    });

    await expect(
      offramp.initiate({
        linkId: "lnk_1",
        quoteId: "q1",
        payout: { currency: "NGN", fields: { dest: "123456789" } },
        customer: OFFLINE_CUSTOMER,
      }),
    ).rejects.toThrow(AnchorTimeoutError);
  });
});

describe.skipIf(!process.env.RUN_LIVE_ANCHOR_TESTS)("TestAnchorOffRamp (live)", () => {
  const telemetry: { rate?: string; quoteLatencyMs?: number; withdrawLatencyMs?: number } = {};

  it("SEP-1: stellar.toml is discoverable and lists required anchor services", async () => {
    const res = await fetch(`${ANCHOR_BASE_URL}/.well-known/stellar.toml`);
    expect(res.status).toBe(200);

    const text = await res.text();
    // The anchor must advertise the endpoints the off-ramp depends on.
    expect(text).toContain("WEB_AUTH_ENDPOINT"); // SEP-10
    expect(text).toContain("TRANSFER_SERVER"); // SEP-6
    expect(text).toContain("ANCHOR_QUOTE_SERVER"); // SEP-38
  });

  it("SEP-10 + SEP-38: quote() returns a positive rate with a future expiry and a valid SEP-10 JWT underneath", async () => {
    const { wiring, customer } = await signedIn(makeKeypair());
    const offramp = makeOffRamp(undefined, wiring);

    const started = Date.now();
    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
      customer,
    });
    telemetry.quoteLatencyMs = Date.now() - started;

    expect(Number(quote.rate)).toBeGreaterThan(0);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
    expect(quote.quoteId).toBeTruthy();

    telemetry.rate = quote.rate;
  });

  it("SEP-6: initiate() then status() completes the request/response round trip", async () => {
    const { wiring, customer } = await signedIn(makeKeypair());
    const offramp = makeOffRamp(undefined, wiring);

    const quote = await offramp.quote({
      linkId: "test-link",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
      customer,
    });

    const initiation = await offramp.initiate({
      linkId: "test-link",
      quoteId: quote.quoteId,
      payout: {
        currency: "USD",
        fields: { type: "bank_account", dest: "1234", dest_extra: "021000021" },
      },
      customer,
    });
    // The on-chain leg is the seller's to sign: either the anchor already
    // named where to send, or it will once its own checks are done.
    expect(["transfer", "fields"]).toContain(initiation.kind);
    expect(initiation.jobId).toBeTruthy();

    const pollStarted = Date.now();
    const polled = await offramp.status(initiation.jobId);
    telemetry.withdrawLatencyMs = Date.now() - pollStarted;

    // Sandbox settlement timing is not deterministic — only assert the shape,
    // never assert eventual "settled".
    expect(["awaiting_transfer", "pending", "settled", "failed"]).toContain(polled.status);
  });

  it("a fresh adapter instance sharing only the persisted state can still resolve status() (restart simulation)", async () => {
    const state = new FakeOffRampStateRepository();
    // Same seller identity both sides of the "restart" — only the process (and
    // its in-memory Maps, pre-fix) would actually be gone, not the keypair.
    const { wiring, customer } = await signedIn(makeKeypair());
    const preRestart = makeOffRamp(state, wiring);

    const quote = await preRestart.quote({
      linkId: "test-link",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
      customer,
    });
    const job = await preRestart.initiate({
      linkId: "test-link",
      quoteId: quote.quoteId,
      payout: {
        currency: "USD",
        fields: { type: "bank_account", dest: "1234", dest_extra: "021000021" },
      },
      customer,
    });

    // New instance, nothing carried over except what `state` persisted. This
    // is what a redeploy looks like.
    // The seller's anchor session is persisted too (anchor_sessions), so the
    // same wiring stands in for it here.
    const postRestart = makeOffRamp(state, wiring);
    const polled = await postRestart.status(job.jobId);
    expect(["awaiting_transfer", "pending", "settled", "failed"]).toContain(polled.status);
  });

  // After all live tests run, emit telemetry for the CI workflow to capture.
  it("emits probe telemetry", () => {
    expect(telemetry.rate).toBeDefined();
    expect(telemetry.quoteLatencyMs).toBeDefined();
    // Merged, not overwritten: the SEP-24 suite and the full cash-out suite record into the same file.
    mergeProbeTelemetry(telemetry);
    expect(existsSync("probe-telemetry.json")).toBe(true);
  });
});
