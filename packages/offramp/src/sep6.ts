import { endpoint } from "./endpoint";

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

/**
 * SEP-6: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md
 *
 * `transferServer` is the anchor's TRANSFER_SERVER from its SEP-1 stellar.toml;
 * `/withdraw` and `/transaction` are SEP-6 paths relative to it.
 */
export async function startSep6Withdraw(
  transferServer: string,
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
  const url = endpoint(transferServer, "withdraw", {
    asset_code: input.assetCode,
    amount: input.amount,
    account: input.account,
    type: input.type,
    dest: input.dest || undefined,
    dest_extra: input.destExtra || undefined,
  });

  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    throw new Error(`SEP-6 withdraw failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; account_id?: string };
  return { id: body.id, accountId: body.account_id };
}

export async function getSep6Transaction(
  transferServer: string,
  jwt: string,
  id: string,
): Promise<Sep6TransactionResult> {
  const url = endpoint(transferServer, "transaction", { id });

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
