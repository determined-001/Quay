"use client";

import { useCallback, useState } from "react";
import { fromStroops, toStroops } from "@checkout/core";
import { api, CheckoutError, type LinkWithRequest } from "../../lib/api";
import { checkPaymentPreflight } from "../../lib/payment-preflight";
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

type WalletPaymentErrorCode =
  | "user_rejected"
  | "insufficient_balance"
  | "missing_trustline"
  | "wrong_network"
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
}

/**
 * Buyer-side wallet payment. This module itself is dynamically imported by
 * CheckoutClient; its Stellar SDK and Wallets Kit dependencies are loaded only
 * after the buyer chooses this path.
 */
export default function WalletPayButton({ initial, disabled = false, onSubmitted }: Props) {
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
      const unsignedXdr = await buildPaymentXdr(address, current);
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
  }, [initial, onSubmitted]);

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
          {walletErrorCopy(error)}
        </p>
      )}
    </div>
  );
}

async function buildPaymentXdr(address: string, initial: LinkWithRequest): Promise<string> {
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
    case "wrong_network":
      return "wrong_network";
    case "wallet_rejected":
      return "user_rejected";
    default:
      return "unavailable";
  }
}

function walletErrorCopy(code: WalletPaymentErrorCode): string {
  switch (code) {
    case "user_rejected":
      return "The wallet request was cancelled.";
    case "insufficient_balance":
      return "Your wallet does not have enough balance to pay this invoice.";
    case "missing_trustline":
      return "Your wallet needs a trustline for this asset before it can pay.";
    case "wrong_network":
      return "Your wallet is connected to the wrong Stellar network. Switch networks and try again.";
    default:
      return "The payment could not be prepared. The QR code and wallet link are still available.";
  }
}
