import type { Keypair } from "@stellar/stellar-sdk";
import type { AssetRef, Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import { Sep10Client } from "./sep10";
import { endpointUrl, fetchStellarToml, type Sep1DiscoveryInfo } from "./sep1";
import { AnchorLimitError } from "./sep6";

export { AnchorLimitError };
export type { Sep1DiscoveryInfo };
export { endpointUrl };

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

/**
 * GET /sep24/info, parsed into the shape the domain uses and cached per base URL
 * for 5 minutes.
 */
export async function getSep24Info(
  baseUrl: string,
  logger?: Logger,
): Promise<Sep24Info> {
  const cached = infoCache.get(baseUrl);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.info;

  const log = (logger ?? NOOP_LOGGER).child({ component: "sep24", baseUrl });
  const res = await fetch(endpointUrl(baseUrl, "info"));
  if (!res.ok) {
    log.warn(
      { event: "anchor.sep24.info.fail", statusCode: res.status },
      "SEP-24 /info failed",
    );
    throw new Error(`SEP-24 /info failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    withdraw?: Record<
      string,
      {
        enabled?: boolean;
        min_amount?: number;
        max_amount?: number;
        fee_fixed?: number;
        fee_percent?: number;
        fee_minimum?: number;
      }
    >;
  };

  const withdraw: Record<string, Sep24AssetInfo> = {};
  for (const [code, raw] of Object.entries(body.withdraw ?? {})) {
    withdraw[code] = {
      enabled: raw.enabled ?? false,
      minAmount: raw.min_amount,
      maxAmount: raw.max_amount,
      feeFixed: raw.fee_fixed,
      feePercent: raw.fee_percent,
      feeMinimum: raw.fee_minimum,
    };
  }

  const info: Sep24Info = { withdraw };
  infoCache.set(baseUrl, { at: Date.now(), info });
  return info;
}

/** Test seam — drops the cached /info for a base URL, or all of them. */
export function clearSep24InfoCache(baseUrl?: string): void {
  if (baseUrl) infoCache.delete(baseUrl);
  else infoCache.clear();
}

/**
 * Validate that the anchor supports withdrawing this asset and that the amount
 * falls within the anchor's published limits.
 */
export function validateSep24Withdraw(
  info: Sep24Info,
  assetCode: string,
  amount: string,
): Sep24AssetInfo {
  const asset = info.withdraw[assetCode];
  if (!asset) {
    throw new AnchorLimitError(
      `Anchor does not list ${assetCode} for withdrawal`,
      {},
      [],
    );
  }
  if (!asset.enabled) {
    throw new AnchorLimitError(
      `Anchor has withdrawal of ${assetCode} disabled`,
    );
  }

  const minAmount = asset.minAmount;
  const maxAmount = asset.maxAmount;
  const value = Number(amount);

  if (!Number.isFinite(value)) {
    throw new AnchorLimitError(`Amount "${amount}" is not a number`, {
      minAmount,
      maxAmount,
    });
  }
  if (minAmount !== undefined && value < minAmount) {
    throw new AnchorLimitError(
      `Amount ${amount} is below the anchor's minimum of ${minAmount} ${assetCode}`,
      { minAmount, maxAmount },
    );
  }
  if (maxAmount !== undefined && value > maxAmount) {
    throw new AnchorLimitError(
      `Amount ${amount} is above the anchor's maximum of ${maxAmount} ${assetCode}`,
      { minAmount, maxAmount },
    );
  }

  return asset;
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
  amountFee?: string;
  message?: string;
  stellarTransactionId?: string;
  moreInfoUrl?: string;
}

function assetIdentifier(asset: AssetRef): string {
  return asset.issuer === null
    ? "stellar:native"
    : `stellar:${asset.code}:${asset.issuer}`;
}

export class Sep24Client {
  private authClient: Sep10Client | null = null;
  private discoveryPromise: Promise<Sep1DiscoveryInfo> | null = null;

  constructor(
    private readonly sellerKeypair: Keypair,
    private readonly homeDomain: string,
  ) {}

  async getDiscoveryInfo(): Promise<Sep1DiscoveryInfo> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = fetchStellarToml(this.homeDomain);
    }
    return this.discoveryPromise;
  }

  private async getAuthToken(): Promise<string> {
    const discovery = await this.getDiscoveryInfo();
    if (!this.authClient) {
      this.authClient = new Sep10Client(this.sellerKeypair, {
        baseUrl: discovery.webAuthEndpoint,
        homeDomain: this.homeDomain,
        signingKey: discovery.signingKey,
      });
    }
    return this.authClient.token();
  }

  async startInteractiveWithdraw(
    input: Sep24WithdrawInteractiveInput,
  ): Promise<Sep24InteractiveResult> {
    const discovery = await this.getDiscoveryInfo();
    const token = await this.getAuthToken();

    const endpoint = endpointUrl(
      discovery.transferServerSep24,
      "transactions/withdraw/interactive",
    );

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
      throw new Error(
        `SEP-24 interactive withdraw failed: ${res.status} ${await res.text()}`,
      );
    }

    const data = (await res.json()) as {
      id: string;
      url: string;
      type: string;
    };
    return {
      id: data.id,
      url: data.url,
      type: data.type || "interactive_customer_info_needed",
    };
  }

  async getTransaction(id: string): Promise<Sep24Transaction> {
    const discovery = await this.getDiscoveryInfo();
    const token = await this.getAuthToken();

    const url = endpointUrl(discovery.transferServerSep24, "transaction");
    url.searchParams.set("id", id);

    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(
        `SEP-24 getTransaction failed: ${res.status} ${await res.text()}`,
      );
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
