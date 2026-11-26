// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  getWalletNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({ getLink: vi.fn(), submitPayment: vi.fn(), getPayOptions: vi.fn() }));
/** What the mock SDK was asked to build: one entry per `TransactionBuilder`. */
interface BuiltTransaction {
  options: { timebounds?: { minTime: number; maxTime: number } };
  operations: Record<string, unknown>[];
  /** The argument of `setTimeout`, or null when it was not called. */
  timeout: number | null;
}
const sdk = vi.hoisted(() => ({ loadAccount: vi.fn(), memos: [] as string[], built: [] as BuiltTransaction[] }));

vi.mock("../lib/wallet", () => ({
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  connectWallet: wallet.connectWallet,
  getWalletNetwork: wallet.getWalletNetwork,
  signTransaction: wallet.signTransaction,
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

// Only the late path (after the link is confirmed payable) reaches the SDK.
vi.mock("@stellar/stellar-sdk", () => {
  class Builder {
    private readonly record: BuiltTransaction;
    constructor(_source: unknown, options: BuiltTransaction["options"]) {
      this.record = { options, operations: [], timeout: null };
      sdk.built.push(this.record);
    }
    addOperation(operation: Record<string, unknown>) {
      this.record.operations.push(operation);
      return this;
    }
    addMemo(memo: string) {
      sdk.memos.push(memo);
      return this;
    }
    setTimeout(seconds: number) {
      this.record.timeout = seconds;
      return this;
    }
    build() {
      return { toXDR: () => "UNSIGNED_XDR" };
    }
  }
  return {
    Horizon: { Server: class { loadAccount = sdk.loadAccount; } },
    Account: class {},
    Asset: Object.assign(
      class {
        constructor(
          readonly code: string,
          readonly issuer: string,
        ) {}
      },
      { native: () => ({ native: true }) },
    ),
    Memo: { text: (m: string) => m },
    Operation: {
      payment: (o: object) => ({ kind: "payment", ...o }),
      pathPaymentStrictReceive: (o: object) => ({ kind: "path", ...o }),
    },
    TransactionBuilder: Builder,
  };
});

import WalletPayButton from "../app/components/WalletPayButton";
import { CheckoutError, setServerSkewForTest, type LinkWithRequest, type PayOption } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PASSPHRASE = "Test SDF Network ; September 2015";

function link(over: Partial<LinkWithRequest["link"]> = {}): LinkWithRequest {
  return {
    link: { id: "lnk_1", status: "active", amount: "10", paidAmount: null, ...over },
    request: {
      uri: "web+stellar:pay?x",
      destination: "GSELLER",
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      memo: "ref_1",
    },
  } as unknown as LinkWithRequest;
}

const fundedAccount = {
  sequence: "100",
  balances: [
    { asset_type: "native", balance: "50.0000000" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "100.0000000" },
  ],
};

describe("WalletPayButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSubmitted = vi.fn();

  async function mount(initial: LinkWithRequest = link()) {
    await act(async () => root.render(<WalletPayButton initial={initial} onSubmitted={onSubmitted} />));
  }
  async function pay() {
    const button = container.querySelector("button")!;
    await act(async () => {
      button.click();
    });
  }
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk.memos.length = 0;
    sdk.built.length = 0;
    wallet.connectWallet.mockResolvedValue("GBUYER");
    wallet.getWalletNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASSPHRASE });
    wallet.signTransaction.mockResolvedValue("SIGNED_XDR");
    apiMock.getLink.mockResolvedValue(link());
    apiMock.submitPayment.mockResolvedValue({ txHash: "tx_abc" });
    sdk.loadAccount.mockResolvedValue(fundedAccount);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders the cancelled copy when the wallet is dismissed at connect", async () => {
    wallet.connectWallet.mockResolvedValue(null);
    await mount();
    await pay();
    expect(alertText()).toBe("The wallet request was cancelled.");
    expect(apiMock.getLink).not.toHaveBeenCalled();
  });

  it("refuses a wallet on the wrong network before touching the API", async () => {
    wallet.getWalletNetwork.mockResolvedValue({ network: "PUBLIC", networkPassphrase: "Public Global Stellar Network ; September 2015" });
    await mount();
    await pay();
    expect(alertText()).toContain("wrong Stellar network");
    expect(apiMock.getLink).not.toHaveBeenCalled();
  });

  it("carries on when the wallet cannot report its network", async () => {
    wallet.getWalletNetwork.mockRejectedValue(new Error("unsupported"));
    await mount();
    await pay();
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
  });

  it.each(["paid", "cancelled", "expired"] as const)("shows the unavailable copy when the link is %s", async (status) => {
    apiMock.getLink.mockResolvedValue(link({ status }));
    await mount();
    await pay();
    expect(alertText()).toContain("could not be prepared");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("maps a CheckoutError from the API through apiErrorCode", async () => {
    const cases: Array<[ConstructorParameters<typeof CheckoutError>[0], string]> = [
      ["insufficient_balance", "does not have enough balance"],
      ["missing_trustline", "needs a trustline"],
      ["price_moved", "The price changed while you were signing. Get a new price and try again."],
      ["no_path", "not enough market depth to pay this in the selected asset right now. Pay in USDC instead."],
      ["wrong_network", "wrong Stellar network"],
      ["wallet_rejected", "The wallet request was cancelled."],
      // Not specially handled, so it falls to the default copy.
      ["payment_rejected", "could not be prepared"],
      ["server_error", "could not be prepared"],
    ];
    for (const [code, copy] of cases) {
      apiMock.submitPayment.mockRejectedValueOnce(new CheckoutError(code, 409, "x"));
      await mount();
      await pay();
      expect(alertText(), code).toContain(copy);
    }
  });

  it("treats an unexpected thrown value as unavailable", async () => {
    apiMock.getLink.mockRejectedValue(new Error("network down"));
    await mount();
    await pay();
    expect(alertText()).toContain("could not be prepared");
  });

  it("reports a cancelled signature as user_rejected", async () => {
    wallet.signTransaction.mockRejectedValue(new Error("User declined"));
    await mount();
    await pay();
    expect(alertText()).toBe("The wallet request was cancelled.");
    expect(apiMock.submitPayment).not.toHaveBeenCalled();
  });

  it("reports an unfunded wallet as insufficient_balance", async () => {
    sdk.loadAccount.mockRejectedValue(new Error("404"));
    await mount();
    await pay();
    expect(alertText()).toContain("does not have enough balance");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("reports a wallet with no trustline as missing_trustline", async () => {
    sdk.loadAccount.mockResolvedValue({ sequence: "1", balances: [{ asset_type: "native", balance: "50.0000000" }] });
    await mount();
    await pay();
    expect(alertText()).toContain("needs a trustline");
  });

  it("reports a balance below the amount as insufficient_balance", async () => {
    sdk.loadAccount.mockResolvedValue({
      sequence: "1",
      balances: [
        { asset_type: "native", balance: "50.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "1.0000000" },
      ],
    });
    await mount();
    await pay();
    expect(alertText()).toContain("does not have enough balance");
  });

  it("only owes the outstanding amount on an underpaid link, and refuses a fully paid one", async () => {
    apiMock.getLink.mockResolvedValue(link({ status: "underpaid", paidAmount: "10" }));
    await mount();
    await pay();
    expect(alertText()).toContain("could not be prepared");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("on success signs, submits the signed XDR and reports the hash with no error shown", async () => {
    await mount();
    await pay();

    expect(wallet.signTransaction).toHaveBeenCalledWith("UNSIGNED_XDR", "GBUYER");
    expect(apiMock.submitPayment).toHaveBeenCalledWith("lnk_1", "SIGNED_XDR");
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    expect(alertText()).toBeNull();
    expect(sdk.memos).toEqual(["ref_1"]);
  });

  it("clears a previous error when the buyer tries again", async () => {
    wallet.connectWallet.mockResolvedValueOnce(null);
    await mount();
    await pay();
    expect(alertText()).not.toBeNull();

    await pay();
    expect(alertText()).toBeNull();
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
  });

  it("is disabled when told to be", async () => {
    await act(async () => root.render(<WalletPayButton initial={link()} disabled onSubmitted={onSubmitted} />));
    expect(container.querySelector("button")!.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Paying with another asset (issue 5.48). The chosen option arrives as a
//  prop from the asset choice (5.47). What the transaction itself contains is
//  read back from real XDR in `payment-transaction.test.ts`; here the SDK is
//  the mock above, which records what the button asked it to build.
// ---------------------------------------------------------------------------

describe("WalletPayButton — paying with another asset", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSubmitted = vi.fn();
  const NOW = 1_763_560_000_000;
  const XLM = { code: "XLM", issuer: null };
  const EURC = { code: "EURC", issuer: "GEURCISSUER" };

  const option = (over: Partial<PayOption> = {}): PayOption => ({
    sourceAsset: XLM,
    sourceAmount: "24.1234567",
    sendMax: "24.3646913",
    path: [],
    quotedAt: NOW,
    expiresAt: NOW + 30_000,
    ...over,
  });

  async function payWith(chosen: PayOption | null, initial: LinkWithRequest = link()) {
    await act(async () =>
      root.render(<WalletPayButton initial={initial} option={chosen} onSubmitted={onSubmitted} />),
    );
    await act(async () => {
      container.querySelector("button")!.click();
    });
  }
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
  /** The one transaction the button built, as the mock recorded it. */
  const built = () => {
    expect(sdk.built).toHaveLength(1);
    return sdk.built[0]!;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    sdk.memos.length = 0;
    sdk.built.length = 0;
    wallet.connectWallet.mockResolvedValue("GBUYER");
    wallet.getWalletNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASSPHRASE });
    wallet.signTransaction.mockResolvedValue("SIGNED_XDR");
    apiMock.getLink.mockResolvedValue(link());
    apiMock.submitPayment.mockResolvedValue({ txHash: "tx_abc" });
    apiMock.getPayOptions.mockResolvedValue({ linkAsset: { code: "USDC", issuer: ISSUER }, amount: "10", options: [] });
    // A buyer who holds XLM and has no USDC trustline at all.
    sdk.loadAccount.mockResolvedValue({ sequence: "100", balances: [{ asset_type: "native", balance: "50.0000000" }] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("builds a strict-receive path payment from the chosen option, expiring with its quote", async () => {
    await payWith(option({ path: [EURC] }));

    const tx = built();
    expect(tx.operations).toEqual([
      {
        kind: "path",
        sendAsset: { native: true },
        sendMax: "24.3646913",
        destination: "GSELLER",
        destAsset: { code: "USDC", issuer: ISSUER },
        destAmount: "10",
        path: [{ code: "EURC", issuer: "GEURCISSUER" }],
      },
    ]);
    // An absolute expiry, the quote's own, and no relative timeout on top of it.
    expect(tx.options.timebounds).toEqual({ minTime: 0, maxTime: (NOW + 30_000) / 1000 });
    expect(tx.timeout).toBeNull();
    expect(sdk.memos).toEqual(["ref_1"]);

    expect(wallet.signTransaction).toHaveBeenCalledWith("UNSIGNED_XDR", "GBUYER");
    expect(apiMock.submitPayment).toHaveBeenCalledWith("lnk_1", "SIGNED_XDR");
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    expect(alertText()).toBeNull();
    // The quote had 30 seconds left: no reason to ask for another.
    expect(apiMock.getPayOptions).not.toHaveBeenCalled();
  });

  it("delivers only what an underpaid link still owes", async () => {
    apiMock.getLink.mockResolvedValue(link({ status: "underpaid", paidAmount: "4.25" }));
    await payWith(option({ sendMax: "14" }));
    expect(built().operations[0]).toMatchObject({ kind: "path", destAmount: "5.75", sendMax: "14" });
  });

  it("checks the buyer's balance of the asset they pay with, not of the link's asset", async () => {
    // 50 XLM, no USDC trustline: fine for a path payment from XLM.
    await payWith(option());
    expect(alertText()).toBeNull();
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
  });

  it("shows insufficient_balance when the wallet holds less than sendMax, reserve and fee included", async () => {
    // 25 XLM covers 24.36 on its own, but not with the 1 XLM reserve and the fee.
    sdk.loadAccount.mockResolvedValue({ sequence: "100", balances: [{ asset_type: "native", balance: "25.0000000" }] });
    await payWith(option());
    expect(alertText()).toContain("does not have enough balance");
    expect(sdk.built).toEqual([]);
    expect(wallet.signTransaction).not.toHaveBeenCalled();

    // The check is on sendMax, not on the quoted amount below it.
    sdk.loadAccount.mockResolvedValue({ sequence: "100", balances: [{ asset_type: "native", balance: "25.3000000" }] });
    await payWith(option());
    expect(alertText()).toContain("does not have enough balance");
    sdk.loadAccount.mockResolvedValue({ sequence: "100", balances: [{ asset_type: "native", balance: "25.3647013" }] });
    await payWith(option());
    expect(alertText()).toBeNull();
  });

  it("shows missing_trustline when the wallet does not hold the issued asset it would pay with", async () => {
    await payWith(option({ sourceAsset: EURC, sendMax: "9.3" }));
    expect(alertText()).toContain("needs a trustline");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("asks for a fresh quote when the chosen one has under ten seconds left, and builds from it", async () => {
    const fresh = option({ sourceAmount: "24", sendMax: "24.24", path: [EURC], quotedAt: NOW, expiresAt: NOW + 30_000 });
    apiMock.getPayOptions.mockResolvedValue({ linkAsset: { code: "USDC", issuer: ISSUER }, amount: "10", options: [option({ sourceAsset: EURC }), fresh] });

    await payWith(option({ expiresAt: NOW + 9_999 }));

    expect(apiMock.getPayOptions).toHaveBeenCalledTimes(1);
    expect(apiMock.getPayOptions).toHaveBeenCalledWith("lnk_1", "GBUYER");
    const tx = built();
    expect(tx.operations[0]).toMatchObject({ kind: "path", sendMax: "24.24", path: [{ code: "EURC", issuer: "GEURCISSUER" }] });
    expect(tx.options.timebounds).toEqual({ minTime: 0, maxTime: (NOW + 30_000) / 1000 });
    expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
  });

  it("counts the time left on the server's clock, not on the buyer's", async () => {
    // The buyer's clock is a minute slow. A quote that looks 30 seconds from
    // its expiry there ran out half a minute ago where it will be checked.
    setServerSkewForTest(60_000);
    try {
      apiMock.getPayOptions.mockResolvedValue({
        linkAsset: { code: "USDC", issuer: ISSUER },
        amount: "10",
        options: [option({ sendMax: "24.3", expiresAt: NOW + 90_000 })],
      });
      await payWith(option({ expiresAt: NOW + 30_000 }));
      expect(apiMock.getPayOptions).toHaveBeenCalledTimes(1);
      expect(built().options.timebounds?.maxTime).toBe((NOW + 90_000) / 1000);
    } finally {
      setServerSkewForTest(0);
    }
  });

  it("keeps a quote with exactly ten seconds left", async () => {
    await payWith(option({ expiresAt: NOW + 10_000 }));
    expect(apiMock.getPayOptions).not.toHaveBeenCalled();
    expect(built().options.timebounds?.maxTime).toBe((NOW + 10_000) / 1000);
  });

  it("builds nothing when the fresh quote would cost more than the buyer was shown", async () => {
    apiMock.getPayOptions.mockResolvedValue({
      linkAsset: { code: "USDC", issuer: ISSUER },
      amount: "10",
      options: [option({ sendMax: "24.3646914" })],
    });
    await payWith(option({ expiresAt: NOW + 2_000 }));
    expect(alertText()).toBe("The price changed before the payment was prepared. Check the new amount and try again.");
    expect(sdk.built).toEqual([]);
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(apiMock.submitPayment).not.toHaveBeenCalled();
  });

  it("builds nothing when the asset is no longer offered", async () => {
    apiMock.getPayOptions.mockResolvedValue({
      linkAsset: { code: "USDC", issuer: ISSUER },
      amount: "10",
      options: [option({ sourceAsset: EURC })],
    });
    await payWith(option({ expiresAt: NOW - 1 }));
    expect(alertText()).toContain("The price changed");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("shows the unavailable copy when the fresh quote cannot be had", async () => {
    apiMock.getPayOptions.mockRejectedValue(new CheckoutError("server_error", 503, "horizon_unavailable"));
    await payWith(option({ expiresAt: NOW + 1_000 }));
    expect(alertText()).toContain("could not be prepared");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it("pays with a plain payment when the chosen option is the link's own asset", async () => {
    sdk.loadAccount.mockResolvedValue(fundedAccount);
    await payWith(option({ sourceAsset: { code: "USDC", issuer: ISSUER }, sourceAmount: "10", sendMax: "10", expiresAt: NOW + 1 }));
    const tx = built();
    expect(tx.operations).toEqual([{ kind: "payment", destination: "GSELLER", asset: { code: "USDC", issuer: ISSUER }, amount: "10" }]);
    expect(tx.options.timebounds).toBeUndefined();
    expect(tx.timeout).toBe(300);
    // Its expiry does not matter: nothing is quoted for a plain payment.
    expect(apiMock.getPayOptions).not.toHaveBeenCalled();
  });

  it("pays with a plain payment, as before, when no option is given", async () => {
    sdk.loadAccount.mockResolvedValue(fundedAccount);
    await payWith(null);
    const tx = built();
    expect(tx.operations).toEqual([{ kind: "payment", destination: "GSELLER", asset: { code: "USDC", issuer: ISSUER }, amount: "10" }]);
    expect(tx.timeout).toBe(300);
    expect(sdk.memos).toEqual(["ref_1"]);
  });
});
