import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OffRampJobNotFoundError, type AnchorCustomer } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { TESTANCHOR_BASE_URL, TESTANCHOR_HOME_DOMAIN, TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// These hit the real https://testanchor.stellar.org sandbox. Off by default —
// it's a shared external service, not something CI should depend on. Run with:
//   RUN_LIVE_ANCHOR_TESTS=1 pnpm --filter @checkout/offramp test
//
// In CI (or locally) you can supply a specific funded testnet keypair via
//   SELLER_SECRET_KEY=<secret>  — otherwise a random keypair is used.
const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ANCHOR_BASE_URL = TESTANCHOR_BASE_URL;

function makeKeypair(): Keypair {
  if (process.env.SELLER_SECRET_KEY) {
    return Keypair.fromSecret(process.env.SELLER_SECRET_KEY);
  }
  return Keypair.random();
}

function anchorWiring() {
  const discovery = new AnchorDiscovery({ homeDomain: TESTANCHOR_HOME_DOMAIN, fallbackBaseUrl: TESTANCHOR_BASE_URL });
  const auth = new SellerAnchorAuth({ discovery, sessions: new FakeAnchorSessionRepository(), networkPassphrase: Networks.TESTNET });
  return { discovery, auth };
}

function makeOffRamp(state = new FakeOffRampStateRepository(), wiring = anchorWiring()) {
  // testanchor offers more than one USDC withdraw type; the adapter refuses to guess.
  return new TestAnchorOffRamp({ ...wiring, state, preferredWithdrawType: "bank_account" });
}

const OFFLINE_CUSTOMER: AnchorCustomer = { sellerId: "sel_1", account: Keypair.random().publicKey() };

/** Sign the live anchor's challenge with the seller's key, as their wallet would in the browser. */
async function signedIn(wallet: Keypair, wiring = anchorWiring()) {
  const customer: AnchorCustomer = { sellerId: "sel_live", account: wallet.publicKey() };
  const { transaction } = await wiring.auth.challenge(customer);
  const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as Transaction;
  tx.sign(wallet);
  await wiring.auth.complete(customer, tx.toXDR());
  return { wiring, customer };
}

describe("TestAnchorOffRamp (offline)", () => {
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
    expect(["pending", "settled", "failed"]).toContain(polled.status);
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
    expect(["pending", "settled", "failed"]).toContain(polled.status);
  });

  // After all live tests run, emit telemetry for the CI workflow to capture.
  it("emits probe telemetry", () => {
    expect(telemetry.rate).toBeDefined();
    expect(telemetry.quoteLatencyMs).toBeDefined();
    writeFileSync("probe-telemetry.json", JSON.stringify(telemetry, null, 2), "utf-8");
    expect(existsSync("probe-telemetry.json")).toBe(true);
  });
});
