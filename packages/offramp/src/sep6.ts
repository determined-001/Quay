import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

export interface Sep6WithdrawResult {
  id: string;
  accountId?: string;
}

/**
 * A single field descriptor as returned by SEP-6 GET /info for a withdraw type.
 * See SEP-6 §3.4 — the anchor returns an `fields` map keyed by field name.
 */
export interface Sep6FieldInfo {
  name: string;
  description: string;
  optional?: boolean;
  choices?: string[];
}

/**
 * GET /sep6/info — returns the withdraw field requirements for a given asset code.
 * The anchor may or may not require authentication for /info; we send the JWT if
 * provided so authenticated anchors can return KYC-aware field sets.
 */
export async function getSep6WithdrawInfo(
  baseUrl: string,
  assetCode: string,
  jwt?: string,
): Promise<Sep6FieldInfo[]> {
  const url = new URL("/sep6/info", baseUrl);
  const headers: Record<string, string> = {};
  if (jwt) headers["authorization"] = `Bearer ${jwt}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`SEP-6 /info failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    withdraw?: Record<
      string,
      {
        enabled?: boolean;
        fields?: Record<string, { description?: string; optional?: boolean; choices?: string[] }>;
      }
    >;
  };

  const assetInfo = body.withdraw?.[assetCode];
  if (!assetInfo?.enabled) {
    throw new Error(`SEP-6 anchor does not support withdrawing ${assetCode}`);
  }

  const rawFields = assetInfo.fields ?? {};
  return Object.entries(rawFields).map(([name, meta]) => ({
    name,
    description: meta.description ?? name,
    optional: meta.optional ?? false,
    choices: meta.choices,
  }));
}

// ---------------------------------------------------------------------------
// SEP-6 /info capability discovery
// ---------------------------------------------------------------------------
// `getSep6WithdrawInfo` above answers "what fields does the form need". This
// pair answers the questions that have to be settled *before* a quote is
// requested: which withdrawal type are we doing, and will the anchor accept
// this amount at all. Asking after quoting means burning a firm quote to
// discover a limit the anchor published all along.

/** One withdrawal type (`bank_account`, `cash`, …) under an asset. */
export interface Sep6WithdrawType {
  fields: Record<string, { description?: string; optional?: boolean; choices?: string[] }>;
  /** Per-type bounds. When present these are tighter than the asset's own. */
  minAmount?: number;
  maxAmount?: number;
}

export interface Sep6AssetInfo {
  enabled: boolean;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
  types: Record<string, Sep6WithdrawType>;
}

export interface Sep6Info {
  withdraw: Record<string, Sep6AssetInfo>;
}

/**
 * Refused *before* a quote is requested, carrying the anchor's own published
 * limits so the caller can tell the seller what would be accepted rather than
 * just that this wasn't.
 */
export class Sep6ValidationError extends Error {
  constructor(
    message: string,
    readonly limits: { minAmount?: number; maxAmount?: number } = {},
    readonly availableTypes: string[] = [],
  ) {
    super(message);
    this.name = "Sep6ValidationError";
  }
}

const INFO_TTL_MS = 5 * 60_000;
const infoCache = new Map<string, { at: number; info: Sep6Info }>();

/**
 * GET /sep6/info, parsed into the shape the domain uses and cached per base URL
 * for 5 minutes. Capability discovery does not change between two cash-outs a
 * minute apart, and an anchor should not be polled once per checkout for it.
 */
export async function getSep6Info(baseUrl: string, logger?: Logger): Promise<Sep6Info> {
  const cached = infoCache.get(baseUrl);
  if (cached && Date.now() - cached.at < INFO_TTL_MS) return cached.info;

  const log = (logger ?? NOOP_LOGGER).child({ component: "sep6", baseUrl });
  const res = await fetch(new URL("/sep6/info", baseUrl));
  if (!res.ok) {
    log.warn({ event: "anchor.sep6.info.fail", statusCode: res.status }, "SEP-6 /info failed");
    throw new Error(`SEP-6 /info failed: ${res.status} ${await res.text()}`);
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
        types?: Record<
          string,
          {
            fields?: Record<string, { description?: string; optional?: boolean; choices?: string[] }>;
            min_amount?: number;
            max_amount?: number;
          }
        >;
      }
    >;
  };

  const withdraw: Record<string, Sep6AssetInfo> = {};
  for (const [code, raw] of Object.entries(body.withdraw ?? {})) {
    const types: Record<string, Sep6WithdrawType> = {};
    for (const [typeName, rawType] of Object.entries(raw.types ?? {})) {
      types[typeName] = {
        fields: rawType.fields ?? {},
        minAmount: rawType.min_amount,
        maxAmount: rawType.max_amount,
      };
    }
    withdraw[code] = {
      enabled: raw.enabled ?? false,
      minAmount: raw.min_amount,
      maxAmount: raw.max_amount,
      feeFixed: raw.fee_fixed,
      feePercent: raw.fee_percent,
      types,
    };
  }

  const info: Sep6Info = { withdraw };
  infoCache.set(baseUrl, { at: Date.now(), info });
  return info;
}

/** Test seam — drops the cached /info for a base URL, or all of them. */
export function clearSep6InfoCache(baseUrl?: string): void {
  if (baseUrl) infoCache.delete(baseUrl);
  else infoCache.clear();
}

/**
 * Decide which withdrawal type to use and confirm the anchor will take this
 * amount, from the anchor's own published capabilities.
 *
 * Ambiguity is an error rather than a guess: if an anchor offers several types
 * and no preference was configured, picking one silently would route a seller's
 * money down a rail nobody chose.
 */
export async function resolveWithdrawType(
  baseUrl: string,
  assetCode: string,
  amount: string,
  preferredType?: string,
  logger?: Logger,
): Promise<{
  type: string;
  typeInfo: Sep6WithdrawType;
  feeFixed?: number;
  feePercent?: number;
}> {
  const info = await getSep6Info(baseUrl, logger);
  const asset = info.withdraw[assetCode];
  if (!asset) {
    throw new Sep6ValidationError(
      `Anchor does not list ${assetCode} for withdrawal`,
      {},
      Object.keys(info.withdraw),
    );
  }
  if (!asset.enabled) {
    throw new Sep6ValidationError(`Anchor has withdrawal of ${assetCode} disabled`);
  }

  const typeNames = Object.keys(asset.types);
  let type: string;
  if (preferredType) {
    if (!typeNames.includes(preferredType)) {
      throw new Sep6ValidationError(
        `Anchor does not offer withdraw type "${preferredType}" for ${assetCode}`,
        { minAmount: asset.minAmount, maxAmount: asset.maxAmount },
        typeNames,
      );
    }
    type = preferredType;
  } else if (typeNames.length === 1) {
    type = typeNames[0]!;
  } else {
    throw new Sep6ValidationError(
      typeNames.length === 0
        ? `Anchor lists no withdraw types for ${assetCode}`
        : `Anchor offers ${typeNames.length} withdraw types for ${assetCode}; set OFFRAMP_TYPE to choose one`,
      { minAmount: asset.minAmount, maxAmount: asset.maxAmount },
      typeNames,
    );
  }

  const typeInfo = asset.types[type]!;
  // Per-type bounds win where present — an anchor may take 1 USDC by cash and
  // 50 by wire, and the asset-level figure is only the outer envelope.
  const minAmount = typeInfo.minAmount ?? asset.minAmount;
  const maxAmount = typeInfo.maxAmount ?? asset.maxAmount;
  const value = Number(amount);

  if (!Number.isFinite(value)) {
    throw new Sep6ValidationError(`Amount "${amount}" is not a number`, { minAmount, maxAmount }, typeNames);
  }
  if (minAmount !== undefined && value < minAmount) {
    throw new Sep6ValidationError(
      `Amount ${amount} is below the anchor's minimum of ${minAmount} ${assetCode}`,
      { minAmount, maxAmount },
      typeNames,
    );
  }
  if (maxAmount !== undefined && value > maxAmount) {
    throw new Sep6ValidationError(
      `Amount ${amount} is above the anchor's maximum of ${maxAmount} ${assetCode}`,
      { minAmount, maxAmount },
      typeNames,
    );
  }

  return { type, typeInfo, feeFixed: asset.feeFixed, feePercent: asset.feePercent };
}

export interface Sep6TransactionResult {
  id: string;
  status: string;
  amountOut?: string;
  message?: string;
}

/** SEP-6: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md */
export async function startSep6Withdraw(
  baseUrl: string,
  jwt: string,
  input: {
    assetCode: string;
    amount: string;
    account: string;
    type: string;
    dest?: string;
    destExtra?: string;
  },
  logger?: Logger,
): Promise<Sep6WithdrawResult> {
  const log = (logger ?? NOOP_LOGGER).child({ component: "sep6", baseUrl });
  const url = new URL("/sep6/withdraw", baseUrl);
  url.searchParams.set("asset_code", input.assetCode);
  url.searchParams.set("amount", input.amount);
  url.searchParams.set("account", input.account);
  url.searchParams.set("type", input.type);
  if (input.dest) url.searchParams.set("dest", input.dest);
  if (input.destExtra) url.searchParams.set("dest_extra", input.destExtra);

  const t0 = Date.now();
  log.info(
    {
      event: "anchor.sep6.withdraw.start",
      assetCode: input.assetCode,
      amount: input.amount,
      account: input.account,
      type: input.type,
    },
    "starting SEP-6 withdraw",
  );
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    log.warn({ event: "anchor.sep6.withdraw.fail", statusCode: res.status, durationMs: Date.now() - t0 }, "SEP-6 withdraw failed");
    throw new Error(`SEP-6 withdraw failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; account_id?: string };
  const out: Sep6WithdrawResult = { id: body.id, accountId: body.account_id };
  log.info(
    { event: "anchor.sep6.withdraw.ok", withdrawId: out.id, accountId: out.accountId, durationMs: Date.now() - t0 },
    "SEP-6 withdraw started",
  );
  return out;
}

export async function getSep6Transaction(
  baseUrl: string,
  jwt: string,
  id: string,
  logger?: Logger,
): Promise<Sep6TransactionResult> {
  const log = (logger ?? NOOP_LOGGER).child({ component: "sep6", baseUrl, transactionId: id });
  const url = new URL("/sep6/transaction", baseUrl);
  url.searchParams.set("id", id);

  const t0 = Date.now();
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    log.warn({ event: "anchor.sep6.status.fail", statusCode: res.status, durationMs: Date.now() - t0 }, "SEP-6 transaction fetch failed");
    throw new Error(`SEP-6 transaction fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    transaction: { id: string; status: string; amount_out?: string; message?: string };
  };
  const out: Sep6TransactionResult = {
    id: body.transaction.id,
    status: body.transaction.status,
    amountOut: body.transaction.amount_out,
    message: body.transaction.message,
  };
  log.info(
    { event: "anchor.sep6.status.ok", status: out.status, amountOut: out.amountOut, durationMs: Date.now() - t0 },
    "SEP-6 transaction polled",
  );
  return out;
}
