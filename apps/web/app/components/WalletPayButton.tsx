"use client";

import { useCallback, useState } from "react";
import { fromStroops, toStroops } from "@checkout/core";
import {
  api,
  CheckoutError,
  type LinkWithRequest,
  type PayOption,
  type PayOptions,
} from "../../lib/api";
import { checkPaymentPreflight } from "../../lib/payment-preflight";
import {
  connectWallet,
  getWalletNetwork,
  NETWORK_PASSPHRASE,
  signTransaction,
} from "../../lib/wallet";
import PayWithChoice, { sameAsset } from "./PayWithChoice";

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ??
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK === "public"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");
const BASE_FEE_STROOPS = 100n;

type WalletPaymentErrorCode =
  | "user_rejected"
  | "insufficient_balance"
  | "missing_trustline"
  | "price_moved"
  | "no_path"
  | "wrong_network"
  /** Chosen a foreign asset, but 5.48 has not built that transaction yet. */
  | "path_payment_unavailable"
  | "unavailable";

class WalletPaymentError extends Error {
  constructor(readonly code: WalletPaymentErrorCode, message: string) {
    super(message);
    this.name = "WalletPaymentError";
  }
}

/**
 * Everything the transaction builder needs (issue 5.47).
 *
 * `payOption` is the buyer's choice: null means "the link asset", and a
 * non-null option is the asset — with its quote — that issue 5.48 turns into a
 * path-payment operation. 5.47 only chooses; building the path payment is 5.48.
 */
export interface PaymentBuildContext {
  address: string;
  initial: LinkWithRequest;
  payOption: PayOption | null;
}

interface Props {
  initial: LinkWithRequest;
  disabled?: boolean;
  onSubmitted: (txHash: string) => void;
  /** Overridable so tests (and 5.48) can own transaction construction. */
  buildTransaction?: (context: PaymentBuildContext) => Promise<string>;
}

/** A quote the buyer is choosing from, kept alongside the link it belongs to. */
interface ChoiceState {
  address: string;
  /** The link as fetched at click time, so the choice prices what is owed now. */
  link: LinkWithRequest;
  /** The whole 4.64 response: link asset, outstanding amount and the options. */
  quote: PayOptions;
  selected: PayOption | null;
}

/**
 * Buyer-side wallet payment. This module itself is dynamically imported by
 * CheckoutClient; its Stellar SDK and Wallets Kit dependencies are loaded only
 * after the buyer chooses this path.
 */
export default function WalletPayButton({ initial, disabled = false, onSubmitted, buildTransaction }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WalletPaymentErrorCode | null>(null);
  const [choice, setChoice] = useState<ChoiceState | null>(null);

  /** Build, sign and submit. Nothing here knows which asset was chosen — the
   *  builder does, and that is the whole point of the 5.47 → 5.48 seam. */
  const submit = useCallback(
    async (address: string, current: LinkWithRequest, payOption: PayOption | null) => {
      const build = buildTransaction ?? buildPaymentXdr;
      const unsignedXdr = await build({ address, initial: current, payOption });
      const signedXdr = await signTransaction(unsignedXdr, address).catch((cause) => {
        throw new WalletPaymentError("user_rejected", walletErrorMessage(cause));
      });
      const result = await api.submitPayment(initial.link.id, signedXdr);
      onSubmitted(result.txHash);
    },
    [buildTransaction, initial.link.id, onSubmitted],
  );

  const pay = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Already chose an asset: this press pays with it.
      if (choice) {
        await submit(choice.address, choice.link, choice.selected);
        return;
      }

      const address = await connectWallet();
      if (!address) throw new WalletPaymentError("user_rejected", "The wallet request was cancelled.");

      const walletNetwork = await getWalletNetwork().catch(() => null);
      if (walletNetwork && walletNetwork.networkPassphrase !== NETWORK_PASSPHRASE) {
        throw new WalletPaymentError("wrong_network", "The wallet is connected to the wrong Stellar network.");
      }

      const current = await api.getLink(initial.link.id);
      if (current.link.status !== "active" && current.link.status !== "underpaid") {
        throw new WalletPaymentError("unavailable", "This payment link is no longer available.");
      }

      // Issue 5.47: when the link allows paying in other assets, offer the
      // choice BEFORE anything is built or signed. No options (or the flag off)
      // keeps the existing one-press payment untouched.
      const pathPayments = current.pay?.pathPayments ?? initial.pay?.pathPayments;
      if (pathPayments) {
        // A quote endpoint hiccup must not stop the buyer paying the link
        // asset, so a failure degrades to "no other options".
        const quote = await api.getPayOptions(initial.link.id, address).catch(() => null);
        if (quote && quote.options.length > 0) {
          setChoice({ address, link: current, quote, selected: null });
          return;
        }
      }

      await submit(address, current, null);
    } catch (cause) {
      if (cause instanceof WalletPaymentError) {
        setError(cause.code);
      } else if (cause instanceof CheckoutError) {
        setError(apiErrorCode(cause));
      } else {
        setError("unavailable");
      }
    } finally {
      setBusy(false);
    }
  }, [choice, initial, submit]);

  /**
   * The active quote aged out. Re-price, and keep the buyer's asset when it is
   * still offered — dropping them back to the link asset mid-flow would make
   * them redo the choice for no reason.
   */
  const requote = useCallback(async () => {
    const active = choice;
    if (!active) return;
    let quote: PayOptions;
    try {
      quote = await api.getPayOptions(active.link.link.id, active.address);
    } catch {
      // A failed re-quote is not "no other assets". Reducing it to an empty
      // list would drop the buyer's chosen asset and quietly point the next
      // press at the link asset — a different payment than the one they picked.
      // Keep the choice; the expired quote stays visible instead.
      return;
    }
    setChoice((prev) => {
      if (!prev) return prev;
      const wanted = prev.selected;
      const stillOffered = wanted
        ? quote.options.find((option) => sameAsset(option.sourceAsset, wanted.sourceAsset))
        : undefined;
      return { ...prev, quote, selected: stillOffered ?? null };
    });
  }, [choice]);

  return (
    <div className="wallet-pay">
      {choice && (
        <PayWithChoice
          linkAsset={choice.quote.linkAsset}
          linkAmount={choice.quote.amount}
          options={choice.quote.options}
          selected={choice.selected}
          onSelect={(option) => setChoice((prev) => (prev ? { ...prev, selected: option } : prev))}
          onExpired={() => void requote()}
        />
      )}
      <button
        type="button"
        className="btn btn--primary btn--block"
        onClick={pay}
        disabled={disabled || busy}
        aria-busy={busy}
      >
        {busy
          ? "Waiting for wallet…"
          : choice
            ? `Pay with ${choice.selected?.sourceAsset.code ?? choice.quote.linkAsset.code}`
            : "Pay with wallet"}
      </button>
      {error && (
        <p className="err" role="alert">
          {walletErrorCopy(error, initial.request.asset.code, choice?.selected?.sourceAsset.code)}
        </p>
      )}
    </div>
  );
}

export async function buildPaymentXdr({ address, initial, payOption }: PaymentBuildContext): Promise<string> {
  // Issue 5.48 constructs the path payment for a chosen foreign asset. Until it
  // lands this builder can only pay the link asset, so it refuses a choice it
  // cannot honour rather than silently charging a different asset than the one
  // the buyer picked. The distinct code lets the UI name both assets instead of
  // showing the generic "could not be prepared" copy.
  if (payOption) {
    throw new WalletPaymentError(
      "path_payment_unavailable",
      `Paying in ${payOption.sourceAsset.code} is not wired up yet.`,
    );
  }

  const stellar = await import("@stellar/stellar-sdk");
  const server = new stellar.Horizon.Server(HORIZON_URL);
  let account: Awaited<ReturnType<typeof server.loadAccount>>;
  try {
    account = await server.loadAccount(address);
  } catch {
    throw new WalletPaymentError("insufficient_balance", "This wallet is not funded on the selected network.");
  }

  const expected = initial.request.asset;
  const outstanding = initial.link.status === "underpaid"
    ? toStroops(initial.link.amount) - toStroops(initial.link.paidAmount ?? "0")
    : toStroops(initial.request.amount);
  if (outstanding <= 0n) {
    throw new WalletPaymentError("unavailable", "This payment link is already fully paid.");
  }
  const paymentAmount = fromStroops(outstanding);

  const preflight = checkPaymentPreflight(
    account,
    expected,
    outstanding,
    { feeStroops: BASE_FEE_STROOPS },
  );

  if (!preflight.ok) {
    if (preflight.reason === "missing_trustline") {
      throw new WalletPaymentError("missing_trustline", `This wallet has no ${expected.code} trustline.`);
    }
    throw new WalletPaymentError("insufficient_balance", preflight.message);
  }

  if (!account.sequence) {
    throw new WalletPaymentError("unavailable", "The wallet account sequence could not be read.");
  }
  const source = new stellar.Account(address, account.sequence);
  const asset = expected.issuer === null
    ? stellar.Asset.native()
    : new stellar.Asset(expected.code, expected.issuer);
  const builder = new stellar.TransactionBuilder(source, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(
    stellar.Operation.payment({
      destination: initial.request.destination,
      asset,
      amount: paymentAmount,
    }),
  );

  if (initial.request.memo) builder.addMemo(stellar.Memo.text(initial.request.memo));
  return builder.setTimeout(300).build().toXDR();
}

function walletErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The wallet request was cancelled.";
}

function apiErrorCode(error: CheckoutError): WalletPaymentErrorCode {
  switch (error.code) {
    case "insufficient_balance":
      return "insufficient_balance";
    case "missing_trustline":
      return "missing_trustline";
    case "price_moved":
      return "price_moved";
    case "no_path":
      return "no_path";
    case "wrong_network":
      return "wrong_network";
    case "wallet_rejected":
      return "user_rejected";
    default:
      return "unavailable";
  }
}

function walletErrorCopy(
  code: WalletPaymentErrorCode,
  linkAssetCode?: string,
  selectedAssetCode?: string,
): string {
  switch (code) {
    case "user_rejected":
      return "The wallet request was cancelled.";
    case "insufficient_balance":
      return "Your wallet does not have enough balance to pay this invoice.";
    case "missing_trustline":
      return "Your wallet needs a trustline for this asset before it can pay.";
    case "price_moved":
      return "The price changed while you were signing. Get a new price and try again.";
    case "no_path":
      return linkAssetCode
        ? `There is not enough market depth to pay this in the selected asset right now. Pay in ${linkAssetCode} instead.`
        : "There is not enough market depth to pay this in the selected asset right now.";
    case "wrong_network":
      return "Your wallet is connected to the wrong Stellar network. Switch networks and try again.";
    case "path_payment_unavailable":
      // Honest interim copy until 5.48 lands: say plainly that this route isn't
      // open yet and which choice still works, rather than a vague failure.
      return selectedAssetCode && linkAssetCode
        ? `Paying in ${selectedAssetCode} isn't available yet. Choose ${linkAssetCode} to pay now.`
        : "Paying in the selected asset isn't available yet.";
    default:
      return "The payment could not be prepared. The QR code and wallet link are still available.";
  }
}
