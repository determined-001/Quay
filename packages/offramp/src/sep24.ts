import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import { anchorHttpError } from "./anchor-error";
import type { AnchorDiscovery } from "./anchor-session";
import { endpointUrl, type Sep1DiscoveryInfo } from "./sep1";
import { Sep6ValidationError } from "./sep6";

export type { Sep1DiscoveryInfo };
export { endpointUrl };

// ---------------------------------------------------------------------------
// SEP-24 /info: published withdrawal limits and fees
// ---------------------------------------------------------------------------

/** One asset's `withdraw` entry from GET /sep24/info. */
export interface Sep24AssetInfo {
  enabled: boolean;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
  feeMinimum?: number;
}

export interface Sep24Info {
  withdraw: Record<string, Sep24AssetInfo>;
}

const INFO_TTL_MS = 5 * 60_000;
const infoCache = new Map<string, { at: number; info: Sep24Info }>();

/** A finite, non-negative number from an anchor field, else undefined (never trust a string or NaN). */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * GET /sep24/info, parsed and cached per base URL for 5 minutes. `baseUrl` is the anchor's
 * SEP-24 transfer server from SEP-1 discovery, never user input. The call is public (no JWT).
 * A failure throws `AnchorHttpError`, whose body stays out of the message.
 */
export async function getSep24Info(baseUrl: string, logger?: Logger): Promise<Sep24Info> {
  const cached = infoCache.get(baseUrl);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.info;

  const log = (logger ?? NOOP_LOGGER).child({ component: "sep24", baseUrl });
  const res = await fetch(endpointUrl(baseUrl, "info"));
  if (!res.ok) {
    log.warn({ event: "anchor.sep24.info.fail", statusCode: res.status }, "SEP-24 /info failed");
    throw await anchorHttpError("24", "/info", res);
  }

  const body = (await res.json()) as {
    withdraw?: Record<
      string,
      {
        enabled?: boolean;
        min_amount?: unknown;
        max_amount?: unknown;
        fee_fixed?: unknown;
        fee_percent?: unknown;
        fee_minimum?: unknown;
      }
    >;
  };

  const withdraw: Record<string, Sep24AssetInfo> = {};
  for (const [code, raw] of Object.entries(body.withdraw ?? {})) {
    withdraw[code] = {
      enabled: raw.enabled === true,
      minAmount: num(raw.min_amount),
      maxAmount: num(raw.max_amount),
      feeFixed: num(raw.fee_fixed),
      feePercent: num(raw.fee_percent),
      feeMinimum: num(raw.fee_minimum),
    };
  }

  const info: Sep24Info = { withdraw };
  infoCache.set(baseUrl, { at: Date.now(), info });
  return info;
}

/** Test seam: drops the cached /info for a base URL, or all of them. */
export function clearSep24InfoCache(baseUrl?: string): void {
  if (baseUrl) infoCache.delete(baseUrl);
  else infoCache.clear();
}

/**
 * Refuses, before any SEP-38 or interactive call, an asset the anchor does not offer for
 * withdrawal or an amount outside its published limits. Throws `Sep6ValidationError` (an
 * `OffRampRejectedError`), so the API answers 422 `offramp_rejected` with the anchor's limits
 * and the circuit breaker does not count it, exactly as on the SEP-6 path.
 */
export function validateSep24Withdraw(info: Sep24Info, assetCode: string, amount: string): Sep24AssetInfo {
  const asset = info.withdraw[assetCode];
  if (!asset) throw new Sep6ValidationError(`Anchor does not list ${assetCode} for withdrawal`);
  if (!asset.enabled) throw new Sep6ValidationError(`Anchor has withdrawal of ${assetCode} disabled`);

  const { minAmount, maxAmount } = asset;
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new Sep6ValidationError(`Amount "${amount}" is not a number`, { minAmount, maxAmount });
  }
  if (minAmount !== undefined && value < minAmount) {
    throw new Sep6ValidationError(`Amount ${amount} is below the anchor's minimum of ${minAmount} ${assetCode}`, {
      minAmount,
      maxAmount,
    });
  }
  if (maxAmount !== undefined && value > maxAmount) {
    throw new Sep6ValidationError(`Amount ${amount} is above the anchor's maximum of ${maxAmount} ${assetCode}`, {
      minAmount,
      maxAmount,
    });
  }
  return asset;
}

/**
 * Fee the anchor's /info implies for withdrawing `amount`, in the SELL asset:
 * `max(fee_minimum, fee_fixed + amount * fee_percent / 100)`. An estimate: the anchor's SEP-38
 * quote or the transaction's `amount_fee` supersedes it. Null when /info publishes no fee
 * fields at all (an unknown fee is not a zero fee).
 */
export function estimateSep24Fee(asset: Sep24AssetInfo, amount: string): number | null {
  const { feeFixed, feePercent, feeMinimum } = asset;
  if (feeFixed === undefined && feePercent === undefined && feeMinimum === undefined) return null;
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.max(feeMinimum ?? 0, (feeFixed ?? 0) + (value * (feePercent ?? 0)) / 100);
}

export interface Sep24WithdrawInteractiveInput {
  assetCode: string;
  assetIssuer?: string;
  amount: string;
  account: string;
  quoteId?: string;
  payoutFields?: Record<string, string>;
}

export interface Sep24InteractiveResult {
  id: string;
  url: string;
  type: string;
}

export interface Sep24Transaction {
  id: string;
  status: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
  amountIn?: string;
  amountOut?: string;
  /** The anchor's final fee, in the sell asset, when it reports one. */
  amountFee?: string;
  message?: string;
  stellarTransactionId?: string;
  moreInfoUrl?: string;
}

/**
 * SEP-24 HTTP calls. It holds no key and signs nothing: every call takes the SELLER's anchor JWT
 * (from `SellerAnchorAuth`, where the seller's own wallet signed the SEP-10 challenge).
 */
export class Sep24Client {
  constructor(private readonly discovery: AnchorDiscovery) {}

  getDiscoveryInfo(): Promise<Sep1DiscoveryInfo> {
    return this.discovery.get();
  }

  async startInteractiveWithdraw(token: string, input: Sep24WithdrawInteractiveInput): Promise<Sep24InteractiveResult> {
    const discovery = await this.getDiscoveryInfo();

    const endpoint = endpointUrl(discovery.transferServerSep24, "transactions/withdraw/interactive");

    const bodyData: Record<string, string> = {
      asset_code: input.assetCode,
      account: input.account,
    };
    if (input.assetIssuer) bodyData.asset_issuer = input.assetIssuer;
    if (input.amount) bodyData.amount = input.amount;
    if (input.quoteId) bodyData.quote_id = input.quoteId;

    if (input.payoutFields) {
      Object.assign(bodyData, input.payoutFields);
    }

    const res = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bodyData),
    });

    if (!res.ok) {
      throw await anchorHttpError("24", "interactive withdraw", res);
    }

    const data = (await res.json()) as { id: string; url: string; type: string };
    return {
      id: data.id,
      url: data.url,
      type: data.type || "interactive_customer_info_needed",
    };
  }

  async getTransaction(token: string, id: string): Promise<Sep24Transaction> {
    const discovery = await this.getDiscoveryInfo();

    const url = endpointUrl(discovery.transferServerSep24, "transaction");
    url.searchParams.set("id", id);

    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw await anchorHttpError("24", "getTransaction", res);
    }

    const data = (await res.json()) as {
      transaction: {
        id: string;
        status: string;
        withdraw_anchor_account?: string;
        withdraw_memo?: string;
        withdraw_memo_type?: string;
        amount_in?: string;
        amount_out?: string;
        amount_fee?: string;
        message?: string;
        stellar_transaction_id?: string;
        more_info_url?: string;
      };
    };

    const tx = data.transaction;
    return {
      id: tx.id,
      status: tx.status,
      withdrawAnchorAccount: tx.withdraw_anchor_account,
      withdrawMemo: tx.withdraw_memo,
      withdrawMemoType: tx.withdraw_memo_type,
      amountIn: tx.amount_in,
      amountOut: tx.amount_out,
      amountFee: tx.amount_fee,
      message: tx.message,
      stellarTransactionId: tx.stellar_transaction_id,
      moreInfoUrl: tx.more_info_url,
    };
  }
}
