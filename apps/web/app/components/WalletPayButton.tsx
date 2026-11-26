"use client";

import { useCallback, useState } from "react";
import { fromStroops, toStroops } from "@checkout/core";
import { api, CheckoutError, serverNow, type LinkWithRequest, type PayOption } from "../../lib/api";
import { checkPaymentPreflight } from "../../lib/payment-preflight";
import { buildPaymentTransaction, isPathOption } from "../../lib/payment-transaction";
import {
  connectWallet,
  getWalletNetwork,
  NETWORK_PASSPHRASE,
  signTransaction,
} from "../../lib/wallet";

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ??
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK === "public"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");
const BASE_FEE_STROOPS = 100n;

/**
 * A quote with less than this left is replaced before it is built into a
 * transaction (issue 5.48): the transaction expires with its quote, and the
 * buyer still has to read the wallet prompt and sign.
 */
const MIN_QUOTE_LEFT_MS = 10_000;

type WalletPaymentErrorCode =
  | "user_rejected"
  | "insufficient_balance"
  | "missing_trustline"
  | "price_moved"
  | "no_path"
  | "wrong_network"
  | "quote_changed"
  | "unavailable";

class WalletPaymentError extends Error {
  constructor(readonly code: WalletPaymentErrorCode, message: string) {
    super(message);
    this.name = "WalletPaymentError";
  }
}

interface Props {
  initial: LinkWithRequest;
  disabled?: boolean;
  onSubmitted: (txHash: string) => void;
  /**
   * The way the buyer chose to pay with another asset (issues 5.47, 5.48).
   * Absent, or in the link's own asset, the payment is a plain one, built
   * exactly as before.
   */
  option?: PayOption | null;
}

/**
 * Buyer-side wallet payment. This module itself is dynamically imported by
 * CheckoutClient; its Stellar SDK and Wallets Kit dependencies are loaded only
 * after the buyer chooses this path.
 */
export default function WalletPayButton({ initial, disabled = false, onSubmitted, option = null }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WalletPaymentErrorCode | null>(null);

  const pay = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
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
      const unsignedXdr = await buildPaymentXdr(address, current, option);
      const signedXdr = await signTransaction(unsignedXdr, address).catch((cause) => {
        throw new WalletPaymentError("user_rejected", walletErrorMessage(cause));
      });

      const result = await api.submitPayment(initial.link.id, signedXdr);
      onSubmitted(result.txHash);
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
  }, [initial, onSubmitted, option]);

  return (
    <div className="wallet-pay">
      <button
        type="button"
        className="btn btn--primary btn--block"
        onClick={pay}
        disabled={disabled || busy}
        aria-busy={busy}
      >
        {busy ? "Waiting for wallet…" : "Pay with wallet"}
      </button>
      {error && (
        <p className="err" role="alert">
          {walletErrorCopy(error, initial.request.asset.code)}
        </p>
      )}
    </div>
  );
}

async function buildPaymentXdr(
  address: string,
  initial: LinkWithRequest,
  chosen: PayOption | null,
): Promise<string> {
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

  // Paying with another asset: the quote that goes into the transaction, live.
  const option = isPathOption(chosen, expected)
    ? await liveOption(initial.link.id, address, chosen)
    : null;

  // The buyer has to hold what the payment takes out of their wallet. For a
  // plain payment that is the link's asset. For a path payment it is the
  // source asset, up to `sendMax`: the link's asset is never theirs to hold.
  const spent = option ? option.sourceAsset : expected;
  const preflight = checkPaymentPreflight(
    account,
    spent,
    option ? toStroops(option.sendMax) : outstanding,
    { feeStroops: BASE_FEE_STROOPS },
  );

  if (!preflight.ok) {
    if (preflight.reason === "missing_trustline") {
      throw new WalletPaymentError("missing_trustline", `This wallet has no ${spent.code} trustline.`);
    }
    throw new WalletPaymentError("insufficient_balance", preflight.message);
  }

  if (!account.sequence) {
    throw new WalletPaymentError("unavailable", "The wallet account sequence could not be read.");
  }
  return buildPaymentTransaction(stellar, {
    source: { address, sequence: account.sequence },
    networkPassphrase: NETWORK_PASSPHRASE,
    feeStroops: BASE_FEE_STROOPS,
    destination: initial.request.destination,
    asset: expected,
    amount: paymentAmount,
    memo: initial.request.memo,
    option,
  });
}

/**
 * The chosen option if its quote has ten seconds or more left on the server's
 * clock, else a fresh quote for the same asset.
 *
 * A fresh quote is used only when it asks for no more than the buyer was
 * shown. If the asset is no longer offered, or would now cost more, nothing is
 * built: the buyer chooses again, with the new figure in front of them.
 */
async function liveOption(linkId: string, address: string, chosen: PayOption): Promise<PayOption> {
  if (chosen.expiresAt - serverNow() >= MIN_QUOTE_LEFT_MS) return chosen;
  const { options } = await api.getPayOptions(linkId, address);
  const fresh = options.find(
    (o) => o.sourceAsset.code === chosen.sourceAsset.code && o.sourceAsset.issuer === chosen.sourceAsset.issuer,
  );
  if (!fresh) {
    throw new WalletPaymentError("quote_changed", `${chosen.sourceAsset.code} can no longer pay this link.`);
  }
  if (toStroops(fresh.sendMax) > toStroops(chosen.sendMax)) {
    throw new WalletPaymentError("quote_changed", "The price went up since it was shown.");
  }
  return fresh;
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

function walletErrorCopy(code: WalletPaymentErrorCode, linkAssetCode?: string): string {
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
    case "quote_changed":
      return "The price changed before the payment was prepared. Check the new amount and try again.";
    default:
      return "The payment could not be prepared. The QR code and wallet link are still available.";
  }
}
