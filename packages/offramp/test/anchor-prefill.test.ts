import { Keypair, Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchorOffRamp, type PrefillSource } from "../src/anchor";
import type { AnchorCustomer, Logger } from "@checkout/core";

/**
 * Issue 3.17 — the adapter's half of prefill: profile ∩ consent, and a log
 * event that carries names only.
 *
 * `AnchorOffRamp` is deliberately not exported from the package index and is
 * not selectable via OFFRAMP (its blocker is state durability, not protocol
 * support), so this exercises it directly — which is also the only way to assert
 * the consent gate without a live anchor.
 */
const CUSTOMER: AnchorCustomer = { sellerId: "sel_1", account: "GSELLER" };

interface Harness {
  bodies: Record<string, string>[];
  logs: Record<string, unknown>[];
}

function stubAnchor(harness: Harness) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/transactions/withdraw/interactive")) {
        harness.bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, string>);
        return new Response(
          JSON.stringify({ id: "txn_1", url: "https://anchor.example/form", type: "" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }),
  );
}

function capturingLogger(harness: Harness): Logger {
  // Rest args, like the real Logger: pino-style calls are (fields, message).
  const record = (...args: unknown[]) => {
    const fields = args[0];
    if (fields && typeof fields === "object") harness.logs.push(fields as Record<string, unknown>);
  };
  return {
    child: () => capturingLogger(harness),
    info: record,
    warn: record,
    error: record,
    debug: record,
  };
}

function offRamp(prefill?: PrefillSource) {
  const sellerKeypair = Keypair.random();
  const r = new AnchorOffRamp({
    homeDomain: "anchor.example",
    sellerKeypair,
    networkPassphrase: Networks.TESTNET,
    prefill,
  });
  const harness: Harness = { bodies: [], logs: [] };
  stubAnchor(harness);
  const c = r as unknown as {
    quotes: Map<string, unknown>;
    sep24: { getDiscoveryInfo: () => Promise<unknown>; getAuthToken: () => Promise<string> };
  };
  // The adapter owns its Sep24Client; stub discovery + SEP-10 on THAT instance so
  // the only thing under test is what initiate() puts in the body.
  c.sep24.getDiscoveryInfo = async () => ({
    transferServerSep24: "https://anchor.example/sep24",
    webAuthEndpoint: "https://anchor.example/auth",
    signingKey: "GSIGNING",
  });
  c.sep24.getAuthToken = async () => "jwt-token";
  // Prime the in-memory quote the adapter requires, so this test is about
  // prefill rather than about SEP-38.
  c.quotes.set("quote_1", {
    sellAsset: { code: "USDC", issuer: "GISSUER" },
    sellAmount: "10",
    buyCurrency: "NGN",
    price: "1500",
  });
  // The adapter sends the seller keypair's own account in the body.
  return { r, harness, account: sellerKeypair.publicKey() };
}

const profile = {
  first_name: "Ada",
  last_name: "Lovelace",
  // Payout details on file. These must never reach the interactive body.
  dest: "0123456789",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnchorOffRamp.initiate — SEP-9 prefill", () => {
  it("sends no SEP-9 keys when the seller has no consent record", async () => {
    const { r, harness, account } = offRamp({
      loadProfile: async () => profile,
      loadConsent: async () => null,
    });

    await r.initiate(
      { linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: profile }, customer: CUSTOMER },
      { logger: capturingLogger(harness) },
    );

    expect(harness.bodies[0]).toEqual({
      asset_code: "USDC",
      asset_issuer: "GISSUER",
      account,
      amount: "10",
      quote_id: "quote_1",
    });
  });

  it("sends no SEP-9 keys when consent exists but names no fields", async () => {
    const { r, harness } = offRamp({
      loadProfile: async () => profile,
      loadConsent: async () => ({ sellerId: "sel_1", anchorDomain: "anchor.example", fields: [], grantedAt: 1 }),
    });

    await r.initiate(
      { linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: profile }, customer: CUSTOMER },
      { logger: capturingLogger(harness) },
    );

    expect(harness.bodies[0]).not.toHaveProperty("first_name");
    expect(harness.bodies[0]).not.toHaveProperty("last_name");
  });

  it("sends exactly first_name when that is the only consented field", async () => {
    const { r, harness } = offRamp({
      loadProfile: async () => profile,
      loadConsent: async () => ({
        sellerId: "sel_1",
        anchorDomain: "anchor.example",
        fields: ["first_name"],
        grantedAt: 1,
      }),
    });

    await r.initiate(
      { linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: profile }, customer: CUSTOMER },
      { logger: capturingLogger(harness) },
    );

    expect(harness.bodies[0].first_name).toBe("Ada");
    expect(harness.bodies[0]).not.toHaveProperty("last_name");
    // The payout field the seller filled in is not forwarded.
    expect(harness.bodies[0]).not.toHaveProperty("dest");
  });

  it("reads consent for this anchor's own domain", async () => {
    const asked: string[] = [];
    const { r } = offRamp({
      loadProfile: async () => profile,
      loadConsent: async (_sellerId, anchorDomain) => {
        asked.push(anchorDomain);
        return null;
      },
    });

    await r.initiate({ linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: {} }, customer: CUSTOMER });

    expect(asked).toEqual(["anchor.example"]);
  });

  it("logs the field NAMES on anchor.sep24.withdraw.start and never the values", async () => {
    const { r, harness } = offRamp({
      loadProfile: async () => profile,
      loadConsent: async () => ({
        sellerId: "sel_1",
        anchorDomain: "anchor.example",
        fields: ["first_name", "last_name"],
        grantedAt: 1,
      }),
    });

    await r.initiate(
      { linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: {} }, customer: CUSTOMER },
      { logger: capturingLogger(harness) },
    );

    const event = harness.logs.find((l) => l.event === "anchor.sep24.withdraw.start");
    expect(event).toBeDefined();
    expect(event?.prefillFields).toEqual(["first_name", "last_name"]);

    const serialized = JSON.stringify(harness.logs);
    expect(serialized).not.toContain("Ada");
    expect(serialized).not.toContain("Lovelace");
    expect(serialized).not.toContain("0123456789");
  });

  it("logs an empty field list when nothing is sent", async () => {
    const { r, harness } = offRamp(undefined);

    await r.initiate(
      { linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: {} }, customer: CUSTOMER },
      { logger: capturingLogger(harness) },
    );

    const event = harness.logs.find((l) => l.event === "anchor.sep24.withdraw.start");
    expect(event?.prefillFields).toEqual([]);
  });

  it("still completes the cash-out when the profile read fails", async () => {
    // Prefill is a convenience, never a precondition: a DB blip must not fail a
    // withdrawal. The anchor's own form is still there for the seller.
    const { r, harness } = offRamp({
      loadProfile: async () => {
        throw new Error("db unavailable");
      },
      loadConsent: async () => ({
        sellerId: "sel_1",
        anchorDomain: "anchor.example",
        fields: ["first_name"],
        grantedAt: 1,
      }),
    });

    const initiation = await r.initiate(
      { linkId: "lnk_1", quoteId: "quote_1", payout: { currency: "NGN", fields: {} }, customer: CUSTOMER },
      { logger: capturingLogger(harness) },
    );

    expect(initiation.jobId).toBe("txn_1");
    expect(harness.bodies[0]).not.toHaveProperty("first_name");
    expect(harness.logs.some((l) => l.event === "anchor.sep24.withdraw.prefill_unavailable")).toBe(true);
  });
});
