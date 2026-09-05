import type { Keypair } from "@stellar/stellar-sdk";
import type { AssetRef } from "@checkout/core";
import { Sep10Client } from "./sep10";
import { endpointUrl, fetchStellarToml, type Sep1DiscoveryInfo } from "./sep1";

export type { Sep1DiscoveryInfo };
export { endpointUrl };

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
  message?: string;
  stellarTransactionId?: string;
  moreInfoUrl?: string;
}

function assetIdentifier(asset: AssetRef): string {
  return asset.issuer === null ? "stellar:native" : `stellar:${asset.code}:${asset.issuer}`;
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

  async startInteractiveWithdraw(input: Sep24WithdrawInteractiveInput): Promise<Sep24InteractiveResult> {
    const discovery = await this.getDiscoveryInfo();
    const token = await this.getAuthToken();

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
      throw new Error(`SEP-24 interactive withdraw failed: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as { id: string; url: string; type: string };
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
      throw new Error(`SEP-24 getTransaction failed: ${res.status} ${await res.text()}`);
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
      message: tx.message,
      stellarTransactionId: tx.stellar_transaction_id,
      moreInfoUrl: tx.more_info_url,
    };
  }
}
