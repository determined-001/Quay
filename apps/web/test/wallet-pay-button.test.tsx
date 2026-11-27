// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  getWalletNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));
const apiMock = vi.hoisted(() => ({
  getLink: vi.fn(),
  submitPayment: vi.fn(),
  getPayOptions: vi.fn(),
}));
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

import WalletPayButton, { type PaymentBuildContext } from "../app/components/WalletPayButton";
import { countdownMilestone, formatPayOption, sameAsset } from "../app/components/PayWithChoice";
import {
  CheckoutError,
  type LinkWithRequest,
  type PayOption,
  type PayOptions,
} from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PASSPHRASE = "Test SDF Network ; September 2015";
/** The 8.30 flag as the link response carries it (issue 5.47). */
const ENABLED: NonNullable<LinkWithRequest["pay"]> = { pathPayments: true, maxSlippageBps: 50 };

function link(
  over: Partial<LinkWithRequest["link"]> = {},
  pay?: LinkWithRequest["pay"],
): LinkWithRequest {
  return {
    link: { id: "lnk_1", status: "active", amount: "10", paidAmount: null, ...over },
    request: {
      uri: "web+stellar:pay?x",
      destination: "GSELLER",
      amount: "10",
      asset: { code: "USDC", issuer: ISSUER },
      memo: "ref_1",
    },
    ...(pay ? { pay } : {}),
  } as unknown as LinkWithRequest;
}

/** One 4.64 quote, with fresh timestamps so a long run never starts expired. */
function payOption(over: Partial<PayOption> = {}): PayOption {
  const now = Date.now();
  return {
    sourceAsset: { code: "XLM", issuer: null },
    sourceAmount: "24.1234567",
    sendMax: "24.3646913",
    path: [],
    quotedAt: now,
    expiresAt: now + 30_000,
    ...over,
  };
}

function payOptions(options: PayOption[] = [payOption()]): PayOptions {
  return { linkAsset: { code: "USDC", issuer: ISSUER }, amount: "10", options };
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

  async function mount(
    initial: LinkWithRequest = link(),
    buildTransaction?: (context: PaymentBuildContext) => Promise<string>,
  ) {
    await act(async () =>
      root.render(
        <WalletPayButton initial={initial} onSubmitted={onSubmitted} buildTransaction={buildTransaction} />,
      ),
    );
  }
  async function pay() {
    const button = container.querySelector("button")!;
    await act(async () => {
      button.click();
    });
  }
  const button = () => container.querySelector("button")!;
  const radios = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

  beforeEach(() => {
    vi.resetAllMocks();
    sdk.memos.length = 0;
    wallet.connectWallet.mockResolvedValue("GBUYER");
    wallet.getWalletNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASSPHRASE });
    wallet.signTransaction.mockResolvedValue("SIGNED_XDR");
    apiMock.getLink.mockResolvedValue(link());
    apiMock.submitPayment.mockResolvedValue({ txHash: "tx_abc" });
    // Default: one quoted alternative, so the choice renders unless a test
    // says otherwise.
    apiMock.getPayOptions.mockResolvedValue(payOptions());
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

  describe("paying with another asset (issue 5.47)", () => {
    it("does not ask for options or show a choice when path payments are off", async () => {
      await mount();
      await pay();

      expect(apiMock.getPayOptions).not.toHaveBeenCalled();
      expect(container.querySelector("fieldset")).toBeNull();
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("keeps the one-press flow when the account has no other options", async () => {
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      apiMock.getPayOptions.mockResolvedValue(payOptions([]));
      await mount();
      await pay();

      expect(apiMock.getPayOptions).toHaveBeenCalledWith("lnk_1", "GBUYER");
      expect(container.querySelector("fieldset")).toBeNull();
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("falls back to the link asset when the quote request fails", async () => {
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      apiMock.getPayOptions.mockRejectedValue(new CheckoutError("server_error", 503, "down"));
      await mount();
      await pay();

      expect(container.querySelector("fieldset")).toBeNull();
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("lists the link asset first, then each quote with its maximum", async () => {
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      await mount();
      await pay();

      const fieldset = container.querySelector("fieldset")!;
      expect(fieldset.querySelector("legend")!.textContent).toBe("Pay with");
      const inputs = radios();
      expect(inputs).toHaveLength(2);
      expect(inputs[0]!.checked).toBe(true);
      expect(inputs[0]!.closest("label")!.textContent).toBe("10 USDC");
      expect(inputs[1]!.closest("label")!.textContent).toBe(
        "about 24.1234567 XLM, at most 24.3646913 XLM",
      );
      expect(fieldset.textContent).toContain("Quote valid for");
      expect(fieldset.textContent).toContain("The QR code always pays in USDC.");
    });

    it("exposes one labelled radio group with a polite status region", async () => {
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      await mount();
      await pay();

      const fieldset = container.querySelector("fieldset")!;
      const inputs = radios();
      expect(new Set(inputs.map((input) => input.name)).size).toBe(1);
      // The group is entered at its first radio, so Tab and Shift+Tab move past
      // the whole choice rather than through every option.
      expect(document.activeElement).toBe(inputs[0]);

      const status = fieldset.querySelector('[role="status"]')!;
      expect(status.getAttribute("aria-live")).toBe("polite");
      // The once-a-second clock must not be in the live region.
      expect(status.textContent).not.toContain("Quote valid for");
    });

    it("moves the selection and the focus with the arrow keys", async () => {
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      await mount();
      await pay();

      radios()[0]!.focus();
      await act(async () => {
        radios()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(radios()[1]!.checked).toBe(true);
      expect(document.activeElement).toBe(radios()[1]);

      await act(async () => {
        radios()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      });
      expect(radios()[0]!.checked).toBe(true);
      expect(document.activeElement).toBe(radios()[0]);

      // Wrap-around, so the group never dead-ends.
      await act(async () => {
        radios()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      });
      expect(radios()[1]!.checked).toBe(true);
    });

    it("passes the chosen option to the builder and submits its transaction", async () => {
      const build = vi.fn(async (_context: PaymentBuildContext) => "UNSIGNED_XDR");
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      await mount(link(), build);
      await pay();

      await act(async () => radios()[1]!.click());
      expect(button().textContent).toBe("Pay with XLM");

      await pay();
      const context = build.mock.calls[0]![0] as PaymentBuildContext;
      expect(context.address).toBe("GBUYER");
      expect(context.payOption?.sourceAsset).toEqual({ code: "XLM", issuer: null });
      expect(context.payOption?.sendMax).toBe("24.3646913");
      expect(wallet.signTransaction).toHaveBeenCalledWith("UNSIGNED_XDR", "GBUYER");
      expect(apiMock.submitPayment).toHaveBeenCalledWith("lnk_1", "SIGNED_XDR");
      expect(onSubmitted).toHaveBeenCalledWith("tx_abc");
    });

    it("passes no path option when the buyer keeps the link asset", async () => {
      const build = vi.fn(async (_context: PaymentBuildContext) => "UNSIGNED_XDR");
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      await mount(link(), build);
      await pay();

      await act(async () => radios()[1]!.click());
      await act(async () => radios()[0]!.click());
      expect(button().textContent).toBe("Pay with USDC");

      await pay();
      expect((build.mock.calls[0]![0] as PaymentBuildContext).payOption).toBeNull();
    });

    it("re-quotes an expired quote and keeps the chosen asset", async () => {
      const soon = Date.now() + 300;
      const fresh = Date.now() + 60_000;
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      apiMock.getPayOptions
        .mockResolvedValueOnce(payOptions([payOption({ expiresAt: soon })]))
        .mockResolvedValueOnce(
          payOptions([payOption({ sourceAmount: "25.0000000", sendMax: "25.2500000", expiresAt: fresh })]),
        );

      await mount();
      await pay();
      await act(async () => radios()[1]!.click());
      expect(button().textContent).toBe("Pay with XLM");

      // One tick of the countdown carries the quote past its deadline.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      });

      expect(apiMock.getPayOptions).toHaveBeenCalledTimes(2);
      expect(radios()[1]!.checked).toBe(true);
      expect(radios()[1]!.closest("label")!.textContent).toBe(
        "about 25.0000000 XLM, at most 25.2500000 XLM",
      );
      expect(button().textContent).toBe("Pay with XLM");
    });

    it("says plainly that a chosen asset cannot be paid yet, until 5.48 lands", async () => {
      apiMock.getLink.mockResolvedValue(link({}, ENABLED));
      await mount();
      await pay();
      await act(async () => radios()[1]!.click());
      await pay();

      expect(alertText()).toBe("Paying in XLM isn't available yet. Choose USDC to pay now.");
      expect(wallet.signTransaction).not.toHaveBeenCalled();
    });
  });
});

describe("PayWithChoice helpers", () => {
  it("treats an asset as itself only when code and issuer both match", () => {
    expect(sameAsset({ code: "XLM", issuer: null }, { code: "XLM", issuer: null })).toBe(true);
    expect(sameAsset({ code: "USDC", issuer: ISSUER }, { code: "USDC", issuer: ISSUER })).toBe(true);
    expect(sameAsset({ code: "USDC", issuer: ISSUER }, { code: "USDC", issuer: null })).toBe(false);
    expect(sameAsset({ code: "USDC", issuer: ISSUER }, { code: "EURC", issuer: ISSUER })).toBe(false);
  });

  it("formats a quote as the about/at-most pair the buyer is shown", () => {
    expect(formatPayOption(payOption())).toBe("about 24.1234567 XLM, at most 24.3646913 XLM");
  });

  it("announces only actionable thresholds, never the ticking clock", () => {
    expect(countdownMilestone(120_000)).toBeNull();
    expect(countdownMilestone(60_000)).toBe("Quote expires in under a minute.");
    expect(countdownMilestone(30_000)).toBe("Quote expires in under 30 seconds.");
    expect(countdownMilestone(10_000)).toBe("Quote expires in under 10 seconds.");
    expect(countdownMilestone(0)).toBe("Quote expired — getting a new price.");
  });
});
