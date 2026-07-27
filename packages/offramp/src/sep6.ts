export interface Sep6WithdrawResult {
  id: string;
  accountId?: string;
}

export interface Sep6TransactionResult {
  id: string;
  status: string;
  amountOut?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// SEP-6 /info — capability discovery
// ---------------------------------------------------------------------------

/** Shape of a single field descriptor returned by GET /sep6/info. */
export interface Sep6FieldDescriptor {
  description: string;
  optional?: boolean;
  choices?: string[];
}

/** Shape of a single withdrawal type entry from GET /sep6/info. */
export interface Sep6WithdrawTypeInfo {
  name: string;
  fields: Record<string, Sep6FieldDescriptor>;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
  enabled: boolean;
}

/** Per-asset withdrawal info as returned by GET /sep6/info. */
export interface Sep6AssetWithdrawInfo {
  enabled: boolean;
  types: Record<string, Sep6WithdrawTypeInfo>;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
}

/** Typed result of getSep6Info — keyed by asset code. */
export interface Sep6Info {
  withdraw: Record<string, Sep6AssetWithdrawInfo>;
}

// Simple in-process TTL cache keyed by baseUrl.
const _infoCache = new Map<string, { data: Sep6Info; expiresAt: number }>();
const INFO_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Fetch and cache GET /sep6/info from the anchor.
 * Results are cached for 5 minutes per base URL.
 */
export async function getSep6Info(baseUrl: string): Promise<Sep6Info> {
  const cached = _infoCache.get(baseUrl);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const res = await fetch(new URL("/sep6/info", baseUrl));
  if (!res.ok) {
    throw new Error(`SEP-6 /info failed: ${res.status} ${await res.text()}`);
  }

  const raw = (await res.json()) as {
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
            fields?: Record<
              string,
              { description?: string; optional?: boolean; choices?: string[] }
            >;
            min_amount?: number;
            max_amount?: number;
            fee_fixed?: number;
            fee_percent?: number;
          }
        >;
      }
    >;
  };

  const withdraw: Record<string, Sep6AssetWithdrawInfo> = {};
  for (const [code, asset] of Object.entries(raw.withdraw ?? {})) {
    const types: Record<string, Sep6WithdrawTypeInfo> = {};
    for (const [typeName, typeData] of Object.entries(asset.types ?? {})) {
      const fields: Record<string, Sep6FieldDescriptor> = {};
      for (const [fieldName, fieldData] of Object.entries(typeData.fields ?? {})) {
        fields[fieldName] = {
          description: fieldData.description ?? fieldName,
          optional: fieldData.optional,
          choices: fieldData.choices,
        };
      }
      types[typeName] = {
        name: typeName,
        fields,
        enabled: true, // anchors only list enabled types in /info
        minAmount: typeData.min_amount,
        maxAmount: typeData.max_amount,
        feeFixed: typeData.fee_fixed,
        feePercent: typeData.fee_percent,
      };
    }
    withdraw[code] = {
      enabled: asset.enabled !== false,
      types,
      minAmount: asset.min_amount,
      maxAmount: asset.max_amount,
      feeFixed: asset.fee_fixed,
      feePercent: asset.fee_percent,
    };
  }

  const data: Sep6Info = { withdraw };
  _infoCache.set(baseUrl, { data, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
  return data;
}

/** Thrown when a requested amount or asset fails the /info limits check. */
export class Sep6ValidationError extends Error {
  constructor(
    message: string,
    readonly limits: { minAmount?: number; maxAmount?: number },
  ) {
    super(message);
    this.name = "Sep6ValidationError";
  }
}

/**
 * Validate `assetCode` is enabled and `amount` is within the anchor's published
 * min/max.  Resolve the withdrawal type from /info:
 *   1. Use `preferredType` if provided and the anchor lists it.
 *   2. Use the only enabled type when exactly one is present.
 *   3. Throw listing available types so the caller can pick.
 *
 * Returns the resolved type key, its full descriptor, and the effective
 * fee_fixed / fee_percent so the caller can feed them into the fee model.
 */
export async function resolveWithdrawType(
  baseUrl: string,
  assetCode: string,
  amount: string,
  preferredType?: string,
): Promise<{
  type: string;
  typeInfo: Sep6WithdrawTypeInfo;
  feeFixed: number;
  feePercent: number;
}> {
  const info = await getSep6Info(baseUrl);
  const assetInfo = info.withdraw[assetCode];

  if (!assetInfo || !assetInfo.enabled) {
    throw new Sep6ValidationError(
      `Anchor does not support withdrawals for asset "${assetCode}"`,
      {},
    );
  }

  const numAmount = Number(amount);
  const assetMin = assetInfo.minAmount;
  const assetMax = assetInfo.maxAmount;

  // Asset-level amount guard (individual types may tighten this further below).
  if (assetMin !== undefined && numAmount < assetMin) {
    throw new Sep6ValidationError(
      `Amount ${amount} is below the anchor minimum of ${assetMin} ${assetCode}`,
      { minAmount: assetMin, maxAmount: assetMax },
    );
  }
  if (assetMax !== undefined && numAmount > assetMax) {
    throw new Sep6ValidationError(
      `Amount ${amount} exceeds the anchor maximum of ${assetMax} ${assetCode}`,
      { minAmount: assetMin, maxAmount: assetMax },
    );
  }

  // Resolve type.
  const enabledTypeKeys = Object.keys(assetInfo.types);
  let resolvedTypeKey: string;

  if (preferredType && assetInfo.types[preferredType]) {
    resolvedTypeKey = preferredType;
  } else if (preferredType) {
    throw new Sep6ValidationError(
      `Withdrawal type "${preferredType}" is not available for ${assetCode}. ` +
        `Available: ${enabledTypeKeys.join(", ")}`,
      { minAmount: assetMin, maxAmount: assetMax },
    );
  } else if (enabledTypeKeys.length === 1) {
    resolvedTypeKey = enabledTypeKeys[0]!;
  } else if (enabledTypeKeys.length === 0) {
    throw new Sep6ValidationError(
      `Anchor has no enabled withdrawal types for ${assetCode}`,
      { minAmount: assetMin, maxAmount: assetMax },
    );
  } else {
    throw new Sep6ValidationError(
      `Multiple withdrawal types available for ${assetCode}: ` +
        `${enabledTypeKeys.join(", ")}. Set OFFRAMP_TYPE to choose one.`,
      { minAmount: assetMin, maxAmount: assetMax },
    );
  }

  const typeInfo = assetInfo.types[resolvedTypeKey]!;

  // Per-type amount validation (overrides asset-level when present).
  const typeMin = typeInfo.minAmount ?? assetMin;
  const typeMax = typeInfo.maxAmount ?? assetMax;
  if (typeMin !== undefined && numAmount < typeMin) {
    throw new Sep6ValidationError(
      `Amount ${amount} is below the anchor minimum of ${typeMin} ${assetCode} ` +
        `for type "${resolvedTypeKey}"`,
      { minAmount: typeMin, maxAmount: typeMax },
    );
  }
  if (typeMax !== undefined && numAmount > typeMax) {
    throw new Sep6ValidationError(
      `Amount ${amount} exceeds the anchor maximum of ${typeMax} ${assetCode} ` +
        `for type "${resolvedTypeKey}"`,
      { minAmount: typeMin, maxAmount: typeMax },
    );
  }

  const feeFixed = typeInfo.feeFixed ?? assetInfo.feeFixed ?? 0;
  const feePercent = typeInfo.feePercent ?? assetInfo.feePercent ?? 0;

  return { type: resolvedTypeKey, typeInfo, feeFixed, feePercent };
}

// ---------------------------------------------------------------------------
// SEP-12 / SEP-6 network calls
// ---------------------------------------------------------------------------

/** SEP-12: minimal KYC so the anchor's SEP-6 withdraw will accept the request. */
export async function putSep12Customer(
  baseUrl: string,
  jwt: string,
  fields: Record<string, string>,
): Promise<void> {
  const res = await fetch(new URL("/sep12/customer", baseUrl), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      first_name: fields.first_name ?? "Demo",
      last_name: fields.last_name ?? "Seller",
      email_address: fields.email_address ?? "demo-seller@example.com",
      ...fields,
    }),
  });
  if (!res.ok) {
    throw new Error(`SEP-12 customer PUT failed: ${res.status} ${await res.text()}`);
  }
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
): Promise<Sep6WithdrawResult> {
  const url = new URL("/sep6/withdraw", baseUrl);
  url.searchParams.set("asset_code", input.assetCode);
  url.searchParams.set("amount", input.amount);
  url.searchParams.set("account", input.account);
  url.searchParams.set("type", input.type);
  if (input.dest) url.searchParams.set("dest", input.dest);
  if (input.destExtra) url.searchParams.set("dest_extra", input.destExtra);

  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    throw new Error(`SEP-6 withdraw failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; account_id?: string };
  return { id: body.id, accountId: body.account_id };
}

export async function getSep6Transaction(
  baseUrl: string,
  jwt: string,
  id: string,
): Promise<Sep6TransactionResult> {
  const url = new URL("/sep6/transaction", baseUrl);
  url.searchParams.set("id", id);

  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    throw new Error(`SEP-6 transaction fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    transaction: { id: string; status: string; amount_out?: string; message?: string };
  };
  return {
    id: body.transaction.id,
    status: body.transaction.status,
    amountOut: body.transaction.amount_out,
    message: body.transaction.message,
  };
}
