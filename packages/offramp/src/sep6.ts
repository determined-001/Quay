import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

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
  logger?: Logger,
): Promise<void> {
  const log = (logger ?? NOOP_LOGGER).child({ component: "sep12", baseUrl });
  const t0 = Date.now();
  log.info({ event: "anchor.sep12.put.start", fieldCount: Object.keys(fields).length }, "submitting SEP-12 KYC");
  // Note: `fields` is intentionally NOT passed to the log line — every key
  // is PII. Both pino's redact list (apps/api) and the no-log policy here
  // make accidental disclosure a two-failure bug.
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
    log.warn({ event: "anchor.sep12.put.fail", statusCode: res.status, durationMs: Date.now() - t0 }, "SEP-12 PUT failed");
    throw new Error(`SEP-12 customer PUT failed: ${res.status} ${await res.text()}`);
  }
  log.info({ event: "anchor.sep12.put.ok", durationMs: Date.now() - t0 }, "SEP-12 PUT ok");
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
