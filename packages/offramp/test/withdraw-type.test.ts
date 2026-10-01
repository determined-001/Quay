import { Keypair, Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorCustomer } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { Sep6ValidationError, clearSep6InfoCache } from "../src/sep6";
import { TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// ---------------------------------------------------------------------------
//  Issue 5.24 — seller-chosen SEP-6 withdrawal type. Offline: every anchor
//  response is a stubbed fetch, keyed by URL. The stellar.toml fetch is made
//  to fail so AnchorDiscovery falls back to the configured base URL, which
//  keeps each test's endpoints unique and stubbable.
// ---------------------------------------------------------------------------

/** testanchor's live /sep6/info shape for USDC — two withdrawal types with
 *  per-type fields — PLUS a decoy asset-level `fields` map. SEP-6 does not
 *  keep withdraw fields at the asset level; a parser that reads them there
 *  is reading the wrong level, which is exactly what this fixture catches. */
const INFO_BODY = {
  withdraw: {
    USDC: {
      enabled: true,
      min_amount: 1,
      max_amount: 10,
      // Decoy: must never surface as a descriptor.
      fields: {
        wrong_level: { description: "asset-level fields are not where SEP-6 keeps these" },
      },
      types: {
        bank_account: {
          fields: {
            dest: { description: "Bank account number" },
            dest_extra: { description: "Routing number", optional: true },
          },
        },
        cash: {
          fields: {
            dest: { description: "Pickup location or ID", optional: true },
          },
        },
      },
    },
  },
};

const SEP38_QUOTE_BODY = {
  id: "quote_wt_1",
  price: "1.02",
  total_price: "1.02",
  sell_amount: "5",
  buy_amount: "4.90",
  expires_at: new Date(Date.now() + 300_000).toISOString(),
};

/** Fetch stub: toml → network failure (forces discovery fallback), /info and
 *  the SEP endpoints → canned JSON. Records every requested URL. */
function stubAnchorFetch(): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/.well-known/stellar.toml")) {
        throw new Error("offline test: no toml");
      }
      const body = url.includes("/info")
        ? INFO_BODY
        : url.includes("/quote")
          ? SEP38_QUOTE_BODY
          : url.includes("/withdraw")
            ? { id: "wd_1", account_id: "GANCHORACCOUNT", memo: "123", memo_type: "id" }
            : null;
      if (body === null) throw new Error(`offline test: unexpected fetch ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }),
  );
  return requested;
}

let counter = 0;
function wiring(preferredWithdrawType?: string) {
  // Unique domain + base per test: both the SEP-1 toml cache and the SEP-6
  // /info cache are module-level and keyed by domain/URL.
  const n = ++counter;
  const homeDomain = `withdraw-type-${n}.test`;
  const discovery = new AnchorDiscovery({ homeDomain, fallbackBaseUrl: `https://anchor-wt-${n}.test` });
  const sessions = new FakeAnchorSessionRepository();
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
  const state = new FakeOffRampStateRepository();
  const offramp = new TestAnchorOffRamp({ discovery, auth, state, preferredWithdrawType });
  return { homeDomain, sessions, state, offramp };
}

function customerWithSession(sessions: FakeAnchorSessionRepository, homeDomain: string): AnchorCustomer {
  const customer: AnchorCustomer = { sellerId: "sel_wt", account: Keypair.random().publicKey() };
  void sessions.save({
    sellerId: customer.sellerId,
    anchorDomain: homeDomain,
    account: customer.account,
    token: "jwt-offline-test",
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
  });
  return customer;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSep6InfoCache();
});

describe("offrampRequirements (issue 5.24)", () => {
  it("returns every offered type with descriptors from types[].fields — never the asset-level fields map", async () => {
    stubAnchorFetch();
    const { offramp } = wiring("bank_account");

    const result = await offramp.offrampRequirements("USDC");

    expect(result.types.map((t) => t.name).sort()).toEqual(["bank_account", "cash"]);
    const bank = result.types.find((t) => t.name === "bank_account")!;
    expect(bank.descriptors.map((d) => d.name).sort()).toEqual(["dest", "dest_extra"]);
    expect(bank.descriptors.find((d) => d.name === "dest")!.label).toBe("Bank account number");
    expect(bank.descriptors.find((d) => d.name === "dest_extra")!.optional).toBe(true);
    const cash = result.types.find((t) => t.name === "cash")!;
    expect(cash.descriptors.map((d) => d.name)).toEqual(["dest"]);

    // The decoy asset-level map must not leak into any type's descriptors.
    for (const t of result.types) {
      expect(t.descriptors.map((d) => d.name)).not.toContain("wrong_level");
    }
  });

  it("defaultType is the operator preference when the anchor offers it", async () => {
    stubAnchorFetch();
    const { offramp } = wiring("cash");
    const result = await offramp.offrampRequirements("USDC");
    expect(result.defaultType).toBe("cash");
  });

  it("defaultType is null when several types exist and no preference is set — the seller must choose", async () => {
    stubAnchorFetch();
    const { offramp } = wiring(undefined);
    const result = await offramp.offrampRequirements("USDC");
    expect(result.defaultType).toBeNull();
  });

  it("defaultType falls back to null when the operator preference names a type the anchor does not offer", async () => {
    stubAnchorFetch();
    const { offramp } = wiring("mobile_money");
    const result = await offramp.offrampRequirements("USDC");
    expect(result.defaultType).toBeNull();
  });
});

describe("quote() withdrawType (issue 5.24)", () => {
  it("the seller's choice wins over the operator default and is persisted on the stored quote", async () => {
    stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring("bank_account");
    const customer = customerWithSession(sessions, homeDomain);

    const q = await offramp.quote({
      linkId: "lnk_wt",
      sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sourceAmount: "5",
      targetCurrency: "USD",
      customer,
      withdrawType: "cash",
    });

    const stored = await state.getQuote(q.quoteId);
    expect(stored?.withdrawType).toBe("cash");
  });

  it("falls back to the operator default when the seller chose nothing", async () => {
    stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring("bank_account");
    const customer = customerWithSession(sessions, homeDomain);

    const q = await offramp.quote({
      linkId: "lnk_wt",
      sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sourceAmount: "5",
      targetCurrency: "USD",
      customer,
    });

    expect((await state.getQuote(q.quoteId))?.withdrawType).toBe("bank_account");
  });

  it("rejects a type the anchor does not offer with the anchor's own list", async () => {
    stubAnchorFetch();
    const { homeDomain, sessions, offramp } = wiring("bank_account");
    const customer = customerWithSession(sessions, homeDomain);

    try {
      await offramp.quote({
        linkId: "lnk_wt",
        sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
        sourceAmount: "5",
        targetCurrency: "USD",
        customer,
        withdrawType: "mobile_money",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Sep6ValidationError);
      expect((err as Sep6ValidationError).availableTypes.sort()).toEqual(["bank_account", "cash"]);
    }
  });
});

describe("initiate() uses the stored quote's type (issue 5.24)", () => {
  it("withdraws on the rail the quote was priced for, not the operator default", async () => {
    const requested = stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring("bank_account");
    const customer = customerWithSession(sessions, homeDomain);

    await state.saveQuote({
      quoteId: "quote_stored_cash",
      linkId: "lnk_wt",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "5",
      buyCurrency: "USD",
      price: "1.02",
      withdrawType: "cash",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await offramp.initiate({
      linkId: "lnk_wt",
      quoteId: "quote_stored_cash",
      payout: { currency: "USD", fields: { dest: "pickup-1" } },
      customer,
    });

    const withdrawCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(withdrawCall).toBeDefined();
    expect(new URL(withdrawCall!).searchParams.get("type")).toBe("cash");
  });
});
