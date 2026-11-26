"use client";

import { useCallback, useState } from "react";
import { fromStroops, toStroops } from "@checkout/core";
import { api, CheckoutError, type LinkWithRequest, type PayOption } from "../../lib/api";
import { checkPaymentPreflight, type PaymentPreflightFail } from "../../lib/payment-preflight";
import {
  buildDirectPaymentXdr,
  buildPathPaymentXdr,
  PathPaymentError,
  planPathPayment,
  type PaymentHorizon,
  type PathPaymentOption,
} from "../../lib/payment-build";
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
  | "unavailable";

class WalletPaymentError extends Error {
  constructor(readonly code: WalletPaymentErrorCode, message: string) {
    super(message);
    this.name = "WalletPaymentError";
  }
}

/**
 * Everything the transaction builder needs (issues 5.47, 5.48).
 *
 * `payOption` is the buyer's choice: null means "the link asset" (a plain
 * payment), and a non-null option is the asset — with the cap they accepted —
 * that becomes a `pathPaymentStrictReceive` built from a fresh quote.
 */
export interface PaymentBuildContext {
  address: string;
  initial: LinkWithRequest;
  payOption: PathPaymentOption | null;
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
  options: PayOption[];
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
        const options = await api
          .getPayOptions(initial.link.id, address)
          .then((body) => body.options)
          .catch(() => [] as PayOption[]);
        if (options.length > 0) {
          setChoice({ address, link: current, options, selected: null });
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
    let options: PayOption[];
    try {
      options = (await api.getPayOptions(active.link.link.id, active.address)).options;
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
      const selected = wanted
        ? options.find((option) => sameAsset(option.sourceAsset, wanted.sourceAsset))
        : undefined;
      return { ...prev, options, selected: selected ?? null };
    });
  }, [choice]);

  const owes = choice ? outstandingAmount(choice.link) : null;

  return (
    <div className="wallet-pay">
      {choice && owes !== null && (
        <PayWithChoice
          linkAmount={owes}
          linkAssetCode={choice.link.request.asset.code}
          options={choice.options}
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
            ? `Pay with ${choice.selected?.sourceAsset.code ?? choice.link.request.asset.code}`
            : "Pay with wallet"}
      </button>
      {error && (
        <p className="err" role="alert">
          {walletErrorCopy(error, initial.request.asset.code)}
        </p>
      )}
    </div>
  );
}

/** What is still owed in the link asset: the full amount, or the remainder on
 *  an underpaid link — the same figure the builder pays. */
function outstandingAmount(initial: LinkWithRequest): string {
  if (initial.link.status !== "underpaid") return initial.link.amount;
  const outstanding = toStroops(initial.link.amount) - toStroops(initial.link.paidAmount ?? "0");
  return outstanding > 0n ? fromStroops(outstanding) : "0";
}

/**
 * The deployment's default `PATH_PAYMENTS_MAX_PRICE_IMPACT_BPS`, used only when
 * an older API response predates the field. The API serves the live value on
 * `GET /links/:id` (issue 5.48), and that is what a current deployment enforces.
 */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 300;

/** Horizon seam for the builder: tests inject one, production uses the real server. */
export interface PaymentBuildDeps {
  horizon?: PaymentHorizon;
}

export async function buildPaymentXdr(
  { address, initial, payOption }: PaymentBuildContext,
  deps: PaymentBuildDeps = {},
): Promise<string> {
  const stellar = await import("@stellar/stellar-sdk");
  const horizon =
    deps.horizon ?? (new stellar.Horizon.Server(HORIZON_URL) as unknown as PaymentHorizon);
  let account: Awaited<ReturnType<PaymentHorizon["loadAccount"]>>;
  try {
    account = await horizon.loadAccount(address);
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

  if (!account.sequence) {
    throw new WalletPaymentError("unavailable", "The wallet account sequence could not be read.");
  }

  const tx = {
    address,
    sequence: account.sequence,
    destination: initial.request.destination,
    destAsset: expected,
    destAmount: paymentAmount,
    networkPassphrase: NETWORK_PASSPHRASE,
    memo: initial.request.memo,
    feeStroops: BASE_FEE_STROOPS,
  };

  if (payOption) {
    // Issue 5.48: the panel's quote is advisory, so price the payment again for
    // the outstanding amount and refuse a conversion the buyer did not accept.
    let plan;
    try {
      plan = await planPathPayment({
        client: horizon,
        buyer: address,
        destAsset: expected,
        destAmount: paymentAmount,
        option: payOption,
        maxPriceImpactBps: initial.pay?.maxPriceImpactBps ?? DEFAULT_MAX_PRICE_IMPACT_BPS,
      });
    } catch (cause) {
      if (cause instanceof PathPaymentError) {
        throw new WalletPaymentError(cause.code, cause.message);
      }
      throw cause;
    }

    // The buyer spends the chosen asset, so that is what has to be funded —
    // not the link asset, which the destination receives through the path.
    const preflight = checkPaymentPreflight(account, plan.sourceAsset, plan.sourceAmount, {
      feeStroops: BASE_FEE_STROOPS,
    });
    if (!preflight.ok) throw preflightError(preflight);

    return buildPathPaymentXdr({ ...tx, plan });
  }

  const preflight = checkPaymentPreflight(
    account,
    expected,
    outstanding,
    { feeStroops: BASE_FEE_STROOPS },
  );
  if (!preflight.ok) throw preflightError(preflight);

  return buildDirectPaymentXdr(tx);
}

function preflightError(preflight: PaymentPreflightFail): WalletPaymentError {
  if (preflight.reason === "missing_trustline") {
    return new WalletPaymentError("missing_trustline", `This wallet has no ${preflight.assetCode} trustline.`);
  }
  return new WalletPaymentError("insufficient_balance", preflight.message);
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
    default:
      return "The payment could not be prepared. The QR code and wallet link are still available.";
  }
}
