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
