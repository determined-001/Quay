import type { AssetRef, Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

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
  logger?: Logger,
): Promise<Sep38QuoteResult> {
  const log = (logger ?? NOOP_LOGGER).child({ component: "sep38", baseUrl });
  const t0 = Date.now();
  log.info(
    {
      event: "anchor.sep38.quote.start",
      sellAsset: input.sellAsset,
      sellAmount: input.sellAmount,
      buyCurrency: input.buyCurrency,
    },
    "fetching SEP-38 quote",
  );
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
    log.warn({ event: "anchor.sep38.quote.fail", statusCode: res.status, durationMs: Date.now() - t0 }, "SEP-38 quote failed");
    throw new Error(`SEP-38 quote failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    id: string;
    price: string;
    sell_amount: string;
    buy_amount: string;
    expires_at: string;
  };
  const out: Sep38QuoteResult = {
    id: body.id,
    price: body.price,
    sellAmount: body.sell_amount,
    buyAmount: body.buy_amount,
    expiresAt: body.expires_at,
  };
  log.info(
    {
      event: "anchor.sep38.quote.ok",
      quoteId: out.id,
      rate: out.price,
      sellAmount: out.sellAmount,
      buyAmount: out.buyAmount,
      buyCurrency: input.buyCurrency,
      durationMs: Date.now() - t0,
    },
    "SEP-38 quote received",
  );
  return out;
}
