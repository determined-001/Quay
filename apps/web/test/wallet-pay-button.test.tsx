// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  getWalletNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({ getLink: vi.fn(), submitPayment: vi.fn() }));
const sdk = vi.hoisted(() => ({ loadAccount: vi.fn(), memos: [] as string[] }));

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
    addOperation() {
      return this;
    }
    addMemo(memo: string) {
      sdk.memos.push(memo);
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { toXDR: () => "UNSIGNED_XDR" };
    }
  }
  return {
    Horizon: { Server: class { loadAccount = sdk.loadAccount; } },
    Account: class {},
    Asset: Object.assign(class {}, { native: () => ({}) }),
    Memo: { text: (m: string) => m },
    Operation: { payment: (o: unknown) => o },
    TransactionBuilder: Builder,
  };
});

import WalletPayButton from "../app/components/WalletPayButton";
import { CheckoutError, type LinkWithRequest } from "../lib/api";

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
