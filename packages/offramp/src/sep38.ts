import type { AssetRef } from "@checkout/core";

export interface Sep38QuoteResult {
  id: string;
  price: string;
  sellAmount: string;
  buyAmount: string;
  expiresAt: string; // ISO 8601
}

function assetIdentifier(asset: AssetRef): string {
  // SEP-38 asset identification format: native XLM is "stellar:native".
  return asset.issuer === null ? "stellar:native" : `stellar:${asset.code}:${asset.issuer}`;
}

/** SEP-38: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md */
export async function getSep38Quote(
  baseUrl: string,
  jwt: string,
  input: { sellAsset: AssetRef; sellAmount: string; buyCurrency: string },
): Promise<Sep38QuoteResult> {
  const res = await fetch(new URL("/sep38/quote", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      sell_asset: assetIdentifier(input.sellAsset),
      sell_amount: input.sellAmount,
      buy_asset: `iso4217:${input.buyCurrency}`,
      buy_delivery_method: "WIRE",
      context: "sep6",
    }),
  });
  if (!res.ok) {
    throw new Error(`SEP-38 quote failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    id: string;
    price: string;
    sell_amount: string;
    buy_amount: string;
    expires_at: string;
  };
  return {
    id: body.id,
    price: body.price,
    sellAmount: body.sell_amount,
    buyAmount: body.buy_amount,
    expiresAt: body.expires_at,
  };
}
