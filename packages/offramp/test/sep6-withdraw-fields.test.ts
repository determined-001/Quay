import { Keypair, Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchorCustomer, Logger } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import {
  RESERVED_WITHDRAW_PARAMS,
  Sep6ValidationError,
  clearSep6InfoCache,
  selectWithdrawFields,
  startSep6Withdraw,
  type Sep6WithdrawType,
} from "../src/sep6";
import { TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

describe("selectWithdrawFields (unit)", () => {
  it("returns non-reserved declared fields present in payout, trimmed", () => {
    const typeInfo: Sep6WithdrawType = {
      fields: {
        bank_number: { description: "Bank code" },
        bank_branch: { description: "Branch code", optional: true },
      },
    };
    const payout = {
      bank_number: " 0123456789 ",
      bank_branch: " 001 ",
    };

    const result = selectWithdrawFields(typeInfo, payout);
    expect(result).toEqual({
      bank_number: "0123456789",
      bank_branch: "001",
    });
  });

  it("omits missing optional fields without throwing", () => {
    const typeInfo: Sep6WithdrawType = {
      fields: {
        account_number: { description: "Account number" },
        routing: { description: "Routing number", optional: true },
      },
    };
    const payout = {
      account_number: "987654321",
    };

    const result = selectWithdrawFields(typeInfo, payout);
    expect(result).toEqual({
      account_number: "987654321",
    });
  });

  it("throws Sep6ValidationError naming the field when a required field is missing", () => {
    const typeInfo: Sep6WithdrawType = {
      fields: {
        iban: { description: "IBAN" },
        bic: { description: "BIC" },
      },
    };
    const payout = {
      iban: "DE89370400440532013000",
    };

    expect(() => selectWithdrawFields(typeInfo, payout)).toThrowError(Sep6ValidationError);
    expect(() => selectWithdrawFields(typeInfo, payout)).toThrowError("Missing required payout field: bic");
  });

  it("treats whitespace-only or empty string as missing and throws for required fields", () => {
    const typeInfo: Sep6WithdrawType = {
      fields: {
        routing: { description: "Routing", optional: false },
      },
    };

    expect(() => selectWithdrawFields(typeInfo, { routing: "" })).toThrowError(
      "Missing required payout field: routing",
    );
    expect(() => selectWithdrawFields(typeInfo, { routing: "   " })).toThrowError(
      "Missing required payout field: routing",
    );
  });

  it("omits optional field when supplied as empty string or whitespace", () => {
    const typeInfo: Sep6WithdrawType = {
      fields: {
        account_number: { description: "Account number" },
        memo_extra: { description: "Optional note", optional: true },
      },
    };
    const payout = {
      account_number: "12345",
      memo_extra: "   ",
    };

    const result = selectWithdrawFields(typeInfo, payout);
    expect(result).toEqual({ account_number: "12345" });
  });

  it("ignores reserved names declared by anchor with a warning and does not count as missing", () => {
    const warnings: unknown[] = [];
    const mockLogger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((data, msg) => warnings.push({ data, msg })),
      error: vi.fn(),
      child: () => mockLogger,
    };

    const typeInfo: Sep6WithdrawType = {
      fields: {
        account_number: { description: "Real account number" },
        // Anchor misdeclaring reserved parameters
        amount: { description: "Reserved" },
        type: { description: "Reserved" },
        account: { description: "Reserved" },
        asset_code: { description: "Reserved" },
      },
    };
    const payout = {
      account_number: "12345",
      amount: "999",
      type: "cash",
      account: "GAEVIL",
      asset_code: "BTC",
    };

    const result = selectWithdrawFields(typeInfo, payout, mockLogger);
    expect(result).toEqual({ account_number: "12345" });
    expect(warnings.length).toBe(4);
  });

  it("never includes undeclared payout fields (e.g. stale saved values)", () => {
    const typeInfo: Sep6WithdrawType = {
      fields: {
        clabe: { description: "CLABE" },
      },
    };
    const payout = {
      clabe: "012180550123456789",
      dest: "stale_dest",
      dest_extra: "stale_extra",
      bank_number: "stale_bank",
      some_other_rail_field: "stale",
    };

    const result = selectWithdrawFields(typeInfo, payout);
    expect(result).toEqual({
      clabe: "012180550123456789",
    });
  });

  it("sends dest and dest_extra only when declared by the type", () => {
    const typeWithoutDest: Sep6WithdrawType = {
      fields: {
        bank_account: { description: "Bank Account" },
      },
    };
    const typeWithDest: Sep6WithdrawType = {
      fields: {
        dest: { description: "Destination account" },
        dest_extra: { description: "Routing", optional: true },
      },
    };

    const payout = {
      bank_account: "BA123",
      dest: "D123",
      dest_extra: "DE456",
    };

    expect(selectWithdrawFields(typeWithoutDest, payout)).toEqual({
      bank_account: "BA123",
    });
    expect(selectWithdrawFields(typeWithDest, payout)).toEqual({
      dest: "D123",
      dest_extra: "DE456",
    });
  });
});

describe("startSep6Withdraw (unit)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends all fields as query parameters", async () => {
    let capturedUrl: URL | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedUrl = new URL(String(input));
        return Response.json({ id: "wd_dyn_1" });
      }),
    );

    await startSep6Withdraw("https://anchor.example/sep6", "jwt", {
      assetCode: "USDC",
      amount: "50",
      account: "GAACCOUNT",
      type: "bank_account",
      fields: {
        bank_number: "034",
        bank_branch: "1234",
        account_number: "567890",
      },
    });

    expect(capturedUrl).toBeDefined();
    expect(capturedUrl!.searchParams.get("bank_number")).toBe("034");
    expect(capturedUrl!.searchParams.get("bank_branch")).toBe("1234");
    expect(capturedUrl!.searchParams.get("account_number")).toBe("567890");
    expect(capturedUrl!.searchParams.get("asset_code")).toBe("USDC");
    expect(capturedUrl!.searchParams.get("amount")).toBe("50");
    expect(capturedUrl!.searchParams.get("account")).toBe("GAACCOUNT");
    expect(capturedUrl!.searchParams.get("type")).toBe("bank_account");
  });

  it("refuses to let fields override asset_code, amount, account, or type", async () => {
    let capturedUrl: URL | undefined;
    const warnings: unknown[] = [];
    const mockLogger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn((data, msg) => warnings.push({ data, msg })),
      error: vi.fn(),
      child: () => mockLogger,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedUrl = new URL(String(input));
        return Response.json({ id: "wd_dyn_2" });
      }),
    );

    await startSep6Withdraw(
      "https://anchor.example/sep6",
      "jwt",
      {
        assetCode: "USDC",
        amount: "50",
        account: "GAACCOUNT",
        type: "bank_account",
        fields: {
          asset_code: "ATTACK_ASSET",
          amount: "0.01",
          account: "GAATTACKER",
          type: "cash",
          bank_number: "034",
        },
      },
      mockLogger,
    );

    expect(capturedUrl).toBeDefined();
    expect(capturedUrl!.searchParams.get("asset_code")).toBe("USDC");
    expect(capturedUrl!.searchParams.get("amount")).toBe("50");
    expect(capturedUrl!.searchParams.get("account")).toBe("GAACCOUNT");
    expect(capturedUrl!.searchParams.get("type")).toBe("bank_account");
    expect(capturedUrl!.searchParams.get("bank_number")).toBe("034");
    expect(warnings.length).toBe(4);
  });
});

describe("initiate with dynamic withdraw fields (integration)", () => {
  let currentBase = "";

  function tomlFor(base: string): string {
    return [
      'VERSION = "2.0.0"',
      `NETWORK_PASSPHRASE = "${Networks.TESTNET}"`,
      `WEB_AUTH_ENDPOINT = "${base}/auth"`,
      `TRANSFER_SERVER = "${base}/sep6"`,
      `TRANSFER_SERVER_SEP0024 = "${base}/sep24"`,
      `KYC_SERVER = "${base}/sep12"`,
      `ANCHOR_QUOTE_SERVER = "${base}/sep38"`,
      'SIGNING_KEY = "GSIGNINGKEY"',
      "",
    ].join("\n");
  }

  const INFO_FIXTURE = {
    withdraw: {
      USDC: {
        enabled: true,
        min_amount: 1,
        max_amount: 1000,
        types: {
          wire: {
            fields: {
              bank_number: { description: "Bank Code" },
              bank_branch: { description: "Branch Code" },
              beneficiary_name: { description: "Beneficiary", optional: true },
            },
          },
          crypto: {
            fields: {
              dest: { description: "Wallet address" },
              dest_extra: { description: "Memo", optional: true },
            },
          },
        },
      },
    },
  };

  function stubAnchorFetch(infoFixture = INFO_FIXTURE): string[] {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/.well-known/stellar.toml")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => tomlFor(currentBase),
          } as Response;
        }
        const body = url.includes("/info")
          ? infoFixture
          : url.includes("/withdraw")
            ? { id: "wd_int_1", account_id: "GANCHORACCOUNT", memo: "123", memo_type: "id" }
            : null;
        if (body === null) throw new Error(`unexpected fetch ${url}`);
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
  function wiring() {
    const n = ++counter;
    const homeDomain = `withdraw-fields-${n}.test`;
    const fallbackBaseUrl = `https://anchor-wf-${n}.test`;
    currentBase = fallbackBaseUrl;
    const discovery = new AnchorDiscovery({ homeDomain, fallbackBaseUrl });
    const sessions = new FakeAnchorSessionRepository();
    const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
    const state = new FakeOffRampStateRepository();
    const offramp = new TestAnchorOffRamp({ discovery, auth, state });
    return { homeDomain, sessions, state, offramp };
  }

  function customerWithSession(sessions: FakeAnchorSessionRepository, homeDomain: string): AnchorCustomer {
    const customer: AnchorCustomer = { sellerId: "sel_wf", account: Keypair.random().publicKey() };
    void sessions.save({
      sellerId: customer.sellerId,
      anchorDomain: homeDomain,
      account: customer.account,
      token: "jwt-test",
      expiresAt: Date.now() + 3_600_000,
      createdAt: Date.now(),
    });
    return customer;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSep6InfoCache();
  });

  it("sends declared bank_number and bank_branch on /withdraw", async () => {
    const requested = stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring();
    const customer = customerWithSession(sessions, homeDomain);

    await state.saveQuote({
      quoteId: "quote_wire_1",
      linkId: "lnk_wf_1",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "100",
      buyCurrency: "USD",
      price: "1.0",
      withdrawType: "wire",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await offramp.initiate({
      linkId: "lnk_wf_1",
      quoteId: "quote_wire_1",
      payout: {
        currency: "USD",
        fields: {
          bank_number: "044",
          bank_branch: "1234",
          beneficiary_name: "Acme Corp",
        },
      },
      customer,
    });

    const withdrawCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(withdrawCall).toBeDefined();
    const searchParams = new URL(withdrawCall!).searchParams;
    expect(searchParams.get("type")).toBe("wire");
    expect(searchParams.get("bank_number")).toBe("044");
    expect(searchParams.get("bank_branch")).toBe("1234");
    expect(searchParams.get("beneficiary_name")).toBe("Acme Corp");
  });

  it("sends dest and dest_extra when declared and omits them when not declared", async () => {
    const requested = stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring();
    const customer = customerWithSession(sessions, homeDomain);

    // Test 1: wire type does not declare dest or dest_extra; payout has them
    await state.saveQuote({
      quoteId: "quote_wire_stale",
      linkId: "lnk_wf_stale",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "100",
      buyCurrency: "USD",
      price: "1.0",
      withdrawType: "wire",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await offramp.initiate({
      linkId: "lnk_wf_stale",
      quoteId: "quote_wire_stale",
      payout: {
        currency: "USD",
        fields: {
          bank_number: "044",
          bank_branch: "1234",
          dest: "stale_dest_123",
          dest_extra: "stale_extra_456",
        },
      },
      customer,
    });

    const wireCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(wireCall).toBeDefined();
    const wireParams = new URL(wireCall!).searchParams;
    expect(wireParams.has("dest")).toBe(false);
    expect(wireParams.has("dest_extra")).toBe(false);
    expect(wireParams.get("bank_number")).toBe("044");

    // Test 2: crypto type declares dest and dest_extra; sends both
    requested.length = 0;
    await state.saveQuote({
      quoteId: "quote_crypto_1",
      linkId: "lnk_wf_crypto",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "50",
      buyCurrency: "USD",
      price: "1.0",
      withdrawType: "crypto",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await offramp.initiate({
      linkId: "lnk_wf_crypto",
      quoteId: "quote_crypto_1",
      payout: {
        currency: "USD",
        fields: {
          dest: "GACRYPTOWALLET",
          dest_extra: "MEMO999",
        },
      },
      customer,
    });

    const cryptoCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(cryptoCall).toBeDefined();
    const cryptoParams = new URL(cryptoCall!).searchParams;
    expect(cryptoParams.get("dest")).toBe("GACRYPTOWALLET");
    expect(cryptoParams.get("dest_extra")).toBe("MEMO999");
  });

  it("prevents payout fields from overriding amount, account, type, or asset_code", async () => {
    const requested = stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring();
    const customer = customerWithSession(sessions, homeDomain);

    await state.saveQuote({
      quoteId: "quote_wire_override",
      linkId: "lnk_wf_ovr",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "100",
      buyCurrency: "USD",
      price: "1.0",
      withdrawType: "wire",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await offramp.initiate({
      linkId: "lnk_wf_ovr",
      quoteId: "quote_wire_override",
      payout: {
        currency: "USD",
        fields: {
          bank_number: "044",
          bank_branch: "1234",
          amount: "0.001",
          account: "GAEVILACCOUNT",
          type: "cash",
          asset_code: "XLM",
        },
      },
      customer,
    });

    const withdrawCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(withdrawCall).toBeDefined();
    const params = new URL(withdrawCall!).searchParams;
    expect(params.get("amount")).toBe("100");
    expect(params.get("account")).toBe(customer.account);
    expect(params.get("type")).toBe("wire");
    expect(params.get("asset_code")).toBe("USDC");
  });

  it("throws Sep6ValidationError when a required field is missing, makes no withdraw request, and saves no job", async () => {
    const requested = stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring();
    const customer = customerWithSession(sessions, homeDomain);

    await state.saveQuote({
      quoteId: "quote_missing_field",
      linkId: "lnk_wf_missing",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "100",
      buyCurrency: "USD",
      price: "1.0",
      withdrawType: "wire",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await expect(
      offramp.initiate({
        linkId: "lnk_wf_missing",
        quoteId: "quote_missing_field",
        payout: {
          currency: "USD",
          fields: {
            bank_number: "044",
            // bank_branch is required and missing!
          },
        },
        customer,
      }),
    ).rejects.toThrowError(Sep6ValidationError);

    // No /sep6/withdraw request made
    const withdrawCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(withdrawCall).toBeUndefined();

    // No job saved to state
    const job = await state.getJob("wd_int_1");
    expect(job).toBeNull();
  });

  it("throws Sep6ValidationError if the withdraw type is no longer in /info, making no withdraw request and saving no job", async () => {
    const requested = stubAnchorFetch();
    const { homeDomain, sessions, state, offramp } = wiring();
    const customer = customerWithSession(sessions, homeDomain);

    await state.saveQuote({
      quoteId: "quote_defunct_type",
      linkId: "lnk_wf_defunct",
      sellAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sellAmount: "100",
      buyCurrency: "USD",
      price: "1.0",
      withdrawType: "discontinued_rail",
      expiresAt: Date.now() + 300_000,
      createdAt: Date.now(),
    });

    await expect(
      offramp.initiate({
        linkId: "lnk_wf_defunct",
        quoteId: "quote_defunct_type",
        payout: {
          currency: "USD",
          fields: {},
        },
        customer,
      }),
    ).rejects.toThrowError(Sep6ValidationError);

    const withdrawCall = requested.find((u) => u.includes("/sep6/withdraw"));
    expect(withdrawCall).toBeUndefined();
  });
});
