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
