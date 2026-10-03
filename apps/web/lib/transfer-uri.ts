import { buildSep7PayUri, type MemoType, type WithdrawTransfer } from "@checkout/core";

/**
 * Turns the anchor's `WithdrawTransfer` into a SEP-7 `pay` URI so a seller whose
 * funds sit in a phone wallet can complete the transfer step from another
 * device. Nothing here signs or submits: the URI is only a request the wallet
 * shows to its owner.
 *
 * The memo is how the anchor matches the payment to the withdrawal, so each
 * memo type is mapped explicitly and a memo that cannot be represented exactly
 * is an error, never a truncated or reinterpreted value.
 */

export class TransferUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferUriError";
  }
}

export interface TransferMemo {
  memo: string;
  memoType: MemoType;
}

const MEMO_TEXT_MAX_BYTES = 28;
const UINT64_MAX = 18446744073709551615n;

/** Decodes a base64 string to bytes, or null when it is not valid base64. */
function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * The canonical base64 form of a 32-byte hash memo. SEP-6 anchors send it
 * base64-encoded (a 64-character hex string is also accepted, matching what the
 * in-browser wallet path does). Anything else is rejected.
 */
export function hashMemoToBase64(memo: string): string {
  if (/^[0-9a-f]{64}$/i.test(memo)) return encodeBase64(hexToBytes(memo));
  const bytes = decodeBase64(memo);
  if (!bytes || bytes.length !== 32) {
    throw new TransferUriError("The anchor sent a hash memo that is not 32 bytes, so it cannot be shown safely.");
  }
  return encodeBase64(bytes);
}

/** Maps the anchor's memo onto the SEP-7 `memo` / `memo_type` pair, or null when there is no memo. */
export function toSep7Memo(transfer: Pick<WithdrawTransfer, "memo" | "memoType">): TransferMemo | null {
  const { memo, memoType } = transfer;
  if (memo === null) return null;

  switch (memoType) {
    case "id": {
      if (!/^\d+$/.test(memo) || BigInt(memo) > UINT64_MAX) {
        throw new TransferUriError("The anchor sent an id memo that is not a valid unsigned 64-bit number.");
      }
      return { memo: BigInt(memo).toString(), memoType: "MEMO_ID" };
    }
    case "hash":
      return { memo: hashMemoToBase64(memo), memoType: "MEMO_HASH" };
    case "text":
    case null: {
      const bytes = new TextEncoder().encode(memo).length;
      if (bytes > MEMO_TEXT_MAX_BYTES) {
        throw new TransferUriError(
          `The anchor sent a text memo of ${bytes} bytes; a Stellar text memo is at most ${MEMO_TEXT_MAX_BYTES}. Pay from your connected wallet instead.`,
        );
      }
      return { memo, memoType: "MEMO_TEXT" };
    }
    default:
      throw new TransferUriError("The anchor sent a memo type this app does not support.");
  }
}

export const TRANSFER_URI_MESSAGE = "Quay cash-out";

/** Builds the `web+stellar:pay` URI for the transfer. Throws {@link TransferUriError} rather than guessing. */
export function buildTransferUri(transfer: WithdrawTransfer, networkPassphrase: string): string {
  const memo = toSep7Memo(transfer);
  try {
    return buildSep7PayUri({
      destination: transfer.destination,
      amount: transfer.amount,
      asset: transfer.asset,
      ...(memo ?? {}),
      message: TRANSFER_URI_MESSAGE,
      networkPassphrase,
    });
  } catch (err) {
    throw new TransferUriError(err instanceof Error ? err.message : "Could not build the payment request.");
  }
}

export interface TransferDetail {
  label: string;
  value: string;
}

/** The fields for the "Copy details" block, for wallets without SEP-7 support. */
export function transferDetails(transfer: WithdrawTransfer): TransferDetail[] {
  const memo = toSep7Memo(transfer);
  const details: TransferDetail[] = [
    { label: "Destination", value: transfer.destination },
    { label: "Amount", value: transfer.amount },
    { label: "Asset", value: transfer.asset.code },
  ];
  if (transfer.asset.issuer) details.push({ label: "Asset issuer", value: transfer.asset.issuer });
  if (memo) {
    details.push({ label: "Memo", value: memo.memo });
    details.push({ label: "Memo type", value: memo.memoType });
  }
  return details;
}

/** Plain-text form of {@link transferDetails}, one `Label: value` per line. */
export function transferDetailsText(transfer: WithdrawTransfer): string {
  return transferDetails(transfer)
    .map((d) => `${d.label}: ${d.value}`)
    .join("\n");
}

function normalizeAmount(amount: string): string {
  const [whole = "0", frac = ""] = amount.split(".");
  const trimmed = frac.replace(/0+$/, "");
  const w = whole.replace(/^0+(?=\d)/, "");
  return trimmed ? `${w}.${trimmed}` : w;
}

/** The subset of a Horizon payment record used to recognise the transfer. */
export interface HorizonPaymentLike {
  type: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** The subset of a Horizon transaction record used to check the memo. */
export interface HorizonTransactionLike {
  memo_type?: string;
  memo?: string;
}

/**
 * True when a ledger payment is the transfer the anchor asked for: same
 * destination, asset and amount, carrying the exact memo. Used to confirm a
 * transfer made from another device; success is never assumed.
 */
export function paymentMatchesTransfer(
  payment: HorizonPaymentLike,
  tx: HorizonTransactionLike,
  transfer: WithdrawTransfer,
): boolean {
  if (payment.type !== "payment" || payment.to !== transfer.destination) return false;
  if (normalizeAmount(payment.amount ?? "") !== normalizeAmount(transfer.amount)) return false;

  if (transfer.asset.issuer === null) {
    if (payment.asset_type !== "native") return false;
  } else if (payment.asset_code !== transfer.asset.code || payment.asset_issuer !== transfer.asset.issuer) {
    return false;
  }

  const memo = toSep7Memo(transfer);
  if (!memo) return true;
  if (memo.memoType === "MEMO_TEXT") return tx.memo_type === "text" && tx.memo === memo.memo;
  if (memo.memoType === "MEMO_ID") return tx.memo_type === "id" && tx.memo === memo.memo;
  // Horizon reports hash memos base64-encoded.
  return tx.memo_type === "hash" && tx.memo === memo.memo;
}
