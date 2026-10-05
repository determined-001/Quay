import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AnchorOffRamp, mapSep24Status } from "../src/anchor";
import type { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { parseStellarToml } from "../src/sep1";
import { FakeOffRampStateRepository } from "./fake-state";

const CUSTOMER = { sellerId: "seller-1", account: "GSELLERACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ" };
// The adapter only needs a seller's JWT; the real SellerAnchorAuth (wallet-signed SEP-10) is covered in anchor-session.test.ts.
const discovery = { homeDomain: "testanchor.stellar.org", get: async () => ({}) } as unknown as AnchorDiscovery;
const auth = { token: async () => "seller-jwt" } as unknown as SellerAnchorAuth;
const adapterOpts = { discovery, auth };

const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("AnchorOffRamp (offline)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parseStellarToml parses SEP-1 discovery endpoints correctly", () => {
    const toml = `
      WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
      TRANSFER_SERVER_SEP24 = "https://testanchor.stellar.org/sep24"
      ANCHOR_QUOTE_SERVER = "https://testanchor.stellar.org/sep38"
    `;
    const parsed = parseStellarToml(toml, "testanchor.stellar.org");
    expect(parsed.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
    expect(parsed.transferServerSep24).toBe("https://testanchor.stellar.org/sep24");
    expect(parsed.anchorQuoteServer).toBe("https://testanchor.stellar.org/sep38");
  });

  it("mapSep24Status maps SEP-24 transaction states onto OffRampJobStatus", () => {
    expect(mapSep24Status("completed")).toBe("settled");
    expect(mapSep24Status("error")).toBe("failed");
    expect(mapSep24Status("refunded")).toBe("failed");
    expect(mapSep24Status("expired")).toBe("failed");
    expect(mapSep24Status("pending_user_transfer_start")).toBe("awaiting_transfer");
    expect(mapSep24Status("pending_anchor")).toBe("pending");
    expect(mapSep24Status("pending_external")).toBe("pending");
  });

  it("pending_user_transfer_start returns transfer instructions without signing on-chain, and survives new adapter instance", async () => {
    const state = new FakeOffRampStateRepository();
        const offramp = new AnchorOffRamp({
      ...adapterOpts,
      state,
    });

    // Seed quote and job into state
    await state.saveQuote({
      quoteId: "quote-1",
      linkId: "link-1",
      sellAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sellAmount: "100.00",
      buyCurrency: "USD",
      price: "1.00",
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
    });

    await state.saveJob({
      jobId: "job-1",
      linkId: "link-1",
      anchor: "testanchor.stellar.org",
      sellerId: CUSTOMER.sellerId,
      account: CUSTOMER.account,
      targetCurrency: "USD",
      targetAmount: "",
      rate: "1.00",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transfer: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Also quote indexed by jobId
    await state.saveQuote({
      quoteId: "job-1",
      linkId: "link-1",
      sellAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sellAmount: "100.00",
      buyCurrency: "USD",
      price: "1.00",
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
    });

    // Mock sep24.getTransaction
    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue({
      id: "job-1",
      status: "pending_user_transfer_start",
      withdrawAnchorAccount: "GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      withdrawMemo: "memo-test-123",
      withdrawMemoType: "text",
      amountIn: "100.00",
      amountOut: "99.00",
    });

    const status1 = await offramp.status("job-1");
    expect(status1.status).toBe("awaiting_transfer");
    expect(status1.transfer).toBeDefined();
    expect(status1.transfer?.destination).toBe("GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(status1.transfer?.amount).toBe("100.00");
    expect(status1.transfer?.asset).toEqual({ code: "USDC", issuer: USDC_TESTNET_ISSUER });
    expect(status1.transfer?.memo).toBe("memo-test-123");
    expect(status1.transfer?.memoType).toBe("text");

    // Check state has transfer persisted
    const storedJob = await state.getJob("job-1");
    expect(storedJob?.transfer).toEqual(status1.transfer);

    // Create a brand new adapter instance with same state (simulating restart)
    const freshOfframp = new AnchorOffRamp({
      ...adapterOpts,
      state,
    });

    vi.spyOn(freshOfframp["sep24"], "getTransaction").mockResolvedValue({
      id: "job-1",
      status: "pending_user_transfer_start",
      withdrawAnchorAccount: "GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      withdrawMemo: "memo-test-123",
      withdrawMemoType: "text",
      amountIn: "100.00",
      amountOut: "99.00",
    });

    const status2 = await freshOfframp.status("job-1");
    expect(status2.transfer).toEqual(status1.transfer);
  });

  it("fails the job if amount_in exceeds the quoted sellAmount", async () => {
    const state = new FakeOffRampStateRepository();
        const offramp = new AnchorOffRamp({
      ...adapterOpts,
      state,
    });

    await state.saveJob({
      jobId: "job-over",
      linkId: "link-over",
      anchor: "testanchor.stellar.org",
      sellerId: CUSTOMER.sellerId,
      account: CUSTOMER.account,
      targetCurrency: "USD",
      targetAmount: "",
      rate: "1.00",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transfer: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await state.saveQuote({
      quoteId: "job-over",
      linkId: "link-over",
      sellAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sellAmount: "50.00",
      buyCurrency: "USD",
      price: "1.00",
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
    });

    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue({
      id: "job-over",
      status: "pending_user_transfer_start",
      withdrawAnchorAccount: "GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      withdrawMemo: "memo-test",
      amountIn: "100.00", // Exceeds 50.00
    });

    const status = await offramp.status("job-over");
    expect(status.status).toBe("failed");
    expect(status.transfer).toBeUndefined();
    expect(status.reason).toContain("exceeds quoted amount");

    const job = await state.getJob("job-over");
    expect(job?.status).toBe("failed");
    expect(job?.transfer).toBeNull();
  });

  it("fails the job if amount_in is missing in pending_user_transfer_start", async () => {
    const state = new FakeOffRampStateRepository();
        const offramp = new AnchorOffRamp({
      ...adapterOpts,
      state,
    });

    await state.saveQuote({
      quoteId: "job-no-amt",
      linkId: "link-no-amt",
      sellAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sellAmount: "100.00",
      buyCurrency: "USD",
      price: "1.00",
      expiresAt: Date.now() + 60000,
      createdAt: Date.now(),
    });

    await state.saveJob({
      jobId: "job-no-amt",
      linkId: "link-no-amt",
      anchor: "testanchor.stellar.org",
      sellerId: CUSTOMER.sellerId,
      account: CUSTOMER.account,
      targetCurrency: "USD",
      targetAmount: "",
      rate: "1.00",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transfer: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue({
      id: "job-no-amt",
      status: "pending_user_transfer_start",
      withdrawAnchorAccount: "GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      withdrawMemo: "memo-test",
      amountIn: undefined,
    });

    const status = await offramp.status("job-no-amt");
    expect(status.status).toBe("failed");
    expect(status.transfer).toBeUndefined();
    expect(status.reason).toContain("Missing amount_in");
  });

  it("clears transfer once status advances past pending_user_transfer_start", async () => {
    const state = new FakeOffRampStateRepository();
        const offramp = new AnchorOffRamp({
      ...adapterOpts,
      state,
    });

    await state.saveJob({
      jobId: "job-adv",
      linkId: "link-adv",
      anchor: "testanchor.stellar.org",
      sellerId: CUSTOMER.sellerId,
      account: CUSTOMER.account,
      targetCurrency: "USD",
      targetAmount: "100.00",
      rate: "1.00",
      status: "pending",
      externalStatus: "pending_user_transfer_start",
      lastError: null,
      transfer: {
        destination: "GANCHORACCOUNT",
        amount: "100.00",
        asset: { code: "USDC", issuer: null },
        memo: "123",
        memoType: "text",
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue({
      id: "job-adv",
      status: "pending_anchor",
      amountOut: "99.00",
    });

    const status = await offramp.status("job-adv");
    expect(status.status).toBe("pending");
    expect(status.transfer).toBeUndefined();

    const job = await state.getJob("job-adv");
    expect(job?.transfer).toBeNull();
  });
  // ---- fail-closed: the transfer is what the seller's wallet will be asked to send -----------------

  async function transferSetup(opts: { quote: boolean }) {
    const state = new FakeOffRampStateRepository();
    const offramp = new AnchorOffRamp({
      ...adapterOpts,
      state,
    });
    if (opts.quote) {
      await state.saveQuote({
        quoteId: "job-x",
        linkId: "link-x",
        sellAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
        sellAmount: "100.00",
        buyCurrency: "USD",
        price: "1.00",
        expiresAt: Date.now() + 60000,
        createdAt: Date.now(),
      });
    }
    await state.saveJob({
      jobId: "job-x",
      linkId: "link-x",
      anchor: "testanchor.stellar.org",
      sellerId: CUSTOMER.sellerId,
      account: CUSTOMER.account,
      targetCurrency: "USD",
      targetAmount: "",
      rate: "1.00",
      status: "pending",
      externalStatus: null,
      lastError: null,
      transferNotifiedAt: null,
      transfer: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { state, offramp };
  }

  const tx = (over: Record<string, unknown> = {}) => ({
    id: "job-x",
    status: "pending_user_transfer_start",
    withdrawAnchorAccount: "GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    withdrawMemo: "memo-test",
    withdrawMemoType: "text",
    amountIn: "50.00",
    ...over,
  });

  it("refuses to offer a transfer when the stored quote is gone, instead of guessing the asset", async () => {
    const { state, offramp } = await transferSetup({ quote: false });
    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue(tx());

    const status = await offramp.status("job-x");

    expect(status.status).toBe("failed");
    expect(status.transfer).toBeUndefined();
    expect(status.reason).toContain("No stored quote");
    expect((await state.getJob("job-x"))?.transfer).toBeNull();
  });

  it.each([["not-a-number"], ["0"], ["-5"], [""]])("refuses an unusable amount_in (%j)", async (amountIn) => {
    const { offramp } = await transferSetup({ quote: true });
    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue(tx({ amountIn }));

    const status = await offramp.status("job-x");

    expect(status.status).toBe("failed");
    expect(status.transfer).toBeUndefined();
    expect(status.reason).toMatch(/amount_in/);
  });

  it("refuses a memo type the wallet cannot build", async () => {
    const { offramp } = await transferSetup({ quote: true });
    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue(tx({ withdrawMemoType: "weird" }));

    const status = await offramp.status("job-x");

    expect(status.status).toBe("failed");
    expect(status.transfer).toBeUndefined();
    expect(status.reason).toContain("Unsupported memo type");
  });

  it("passes a valid id memo through exactly, and always pays the asset that was quoted", async () => {
    const { offramp } = await transferSetup({ quote: true });
    vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue(
      tx({ withdrawMemo: "12345", withdrawMemoType: "id" }),
    );

    const status = await offramp.status("job-x");

    expect(status.status).toBe("awaiting_transfer");
    expect(status.transfer).toEqual({
      destination: "GANCHORACCOUNT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      amount: "50.00",
      asset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      memo: "12345",
      memoType: "id",
    });
  });

  it("runs every anchor call with the seller's own session JWT, and refuses a job that has no seller", async () => {
    const { state, offramp } = await transferSetup({ quote: true });
    const getTransaction = vi.spyOn(offramp["sep24"], "getTransaction").mockResolvedValue(tx());
    const token = vi.spyOn(auth, "token");

    await offramp.status("job-x");
    expect(token).toHaveBeenCalledWith({ sellerId: CUSTOMER.sellerId, account: CUSTOMER.account });
    expect(getTransaction).toHaveBeenCalledWith("seller-jwt", "job-x");

    await state.updateJob("job-x", { sellerId: null, account: null });
    await expect(offramp.status("job-x")).rejects.toThrow(/not found|unknown/i);
  });

  it("requires a state repository: there is no in-memory default to lose on restart", () => {
    // @ts-expect-error `state` is a required option
    const build = () => new AnchorOffRamp({ ...adapterOpts });
    expect(build).toThrow();
  });

  // ---- issue 3.18: nothing server-side may sign or submit a payment ---------------------------------

  it("no code under packages/offramp or apps/api builds AND signs a payment transaction", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const roots = [join(here, "..", "src"), join(here, "..", "..", "..", "apps", "api", "src")];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const rel of readdirSync(root, { recursive: true }) as string[]) {
        if (!rel.endsWith(".ts")) continue;
        const text = readFileSync(join(root, rel), "utf8");
        // SEP-10 challenge handling legitimately signs, but it never builds a payment operation.
        if (text.includes("Operation.payment(") && text.includes(".sign(")) offenders.push(rel);
        if (text.includes("sendWithdrawalPayment")) offenders.push(`${rel} (sendWithdrawalPayment)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
