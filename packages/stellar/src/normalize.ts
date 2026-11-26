import type { Horizon } from "@stellar/stellar-sdk";
import type { AssetRef, NormalizedPayment } from "@checkout/core";

// Operation types that move value to a recipient and carry a destination asset/amount.
const VALUE_TYPES = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

// Path payments convert an asset on the way, so Horizon reports two sides:
// `amount`/`asset_*` is what the destination received, `source_amount`/
// `source_asset_*` is what the payer spent. Only path payments have the latter.
const PATH_PAYMENT_TYPES = new Set([
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

type AnyRecord = Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.OperationRecord;

interface ValueFields {
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  // Present when the operation's destination was specified as an SEP-23
  // M-address; Horizon still normalizes `to` to the underlying G-address.
  to_muxed_id?: string;
  // Present when the payer sent from an M-address. `from` is still the
  // G-address; these two say which sub-account of it paid.
  from_muxed?: string;
  from_muxed_id?: string;
}

export type OperationWithTransaction = { transaction_hash: string; transaction: () => Promise<Horizon.ServerApi.TransactionRecord> };

/** Resolves an operation record's parent transaction. Injected so the watcher
 *  can supply a per-tick memoized/batched implementation (see horizon-watcher.ts)
 *  instead of every record hitting Horizon independently. */
export type FetchTransaction = (record: OperationWithTransaction) => Promise<Horizon.ServerApi.TransactionRecord>;

const defaultFetchTransaction: FetchTransaction = (record) => record.transaction();

export function isValuePayment(record: AnyRecord): boolean {
  return VALUE_TYPES.has(record.type);
}

function assetOf(r: ValueFields): AssetRef {
  if (r.asset_type === "native" || r.asset_type === undefined) {
    return { code: "XLM", issuer: null };
  }
  return { code: r.asset_code ?? "", issuer: r.asset_issuer ?? null };
}

/** The paid side of a path payment, from Horizon's `source_asset_*` fields. */
function sourceAssetOf(r: ValueFields): AssetRef {
  return assetOf({
    asset_type: r.source_asset_type,
    asset_code: r.source_asset_code,
    asset_issuer: r.source_asset_issuer,
  });
}

/**
 * Convert a raw Horizon record into a NormalizedPayment.
 * The memo lives on the *transaction*, not the operation, so we fetch it via
 * `fetchTransaction` — with `join=transactions` on the originating query
 * (see horizon-watcher.ts) this resolves from data already in hand, no
 * follow-up request. Returns null for non-value operations (e.g. create_account).
 *
 * A transaction-fetch failure is NOT downgraded to a `no_memo` outcome — it
 * throws, so a transient Horizon blip retries the whole tick instead of
 * silently parking a matchable payment as unmatched.
 */
export async function normalizePayment(
  record: AnyRecord,
  fetchTransaction: FetchTransaction = defaultFetchTransaction,
): Promise<NormalizedPayment | null> {
  if (!isValuePayment(record)) return null;
  const r = record as unknown as ValueFields &
    OperationWithTransaction & {
      paging_token: string;
      created_at: string;
    };

  const tx = await fetchTransaction(r);
  const memoType = tx.memo_type ?? null;
  const memo = memoType && memoType !== "none" ? (tx.memo ?? null) : null;
  const isPathPayment = PATH_PAYMENT_TYPES.has(record.type);

  return {
    txHash: r.transaction_hash,
    pagingToken: r.paging_token,
    from: r.from ?? "",
    fromMuxed: r.from_muxed ?? null,
    to: r.to ?? "",
    amount: r.amount ?? "0",
    asset: assetOf(r),
    // For a path payment Horizon's `amount`/`asset_*` are the delivered side;
    // the paid side rides along for the receipt/CSV but never decides a match.
    sourceAsset: isPathPayment ? sourceAssetOf(r) : null,
    sourceAmount: isPathPayment ? (r.source_amount ?? null) : null,
    memo,
    memoType,
    toMuxedId: r.to_muxed_id ?? null,
    createdAt: r.created_at,
    // Horizon exposes the sequence as `ledger_attr` on the transaction record;
    // plain `ledger` is the method that fetches the ledger itself.
    ledger: tx.ledger_attr ?? 0,
  };
}
