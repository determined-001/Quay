import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { AssetRef } from "@checkout/core";
import { fromStroops, toStroops } from "@checkout/core";

export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

/** Converts an AssetRef to a Stellar SDK Asset. */
export function toSdkAsset(ref: AssetRef): Asset {
  return ref.issuer === null ? Asset.native() : new Asset(ref.code, ref.issuer);
}

/**
 * Computes sendMax with slippage, ceiling-rounded at the stroop boundary so it
 * never rounds down and causes false op_over_source_max rejections.
 */
export function calculateSendMax(sourceAmount: string, slippageBps = 100): string {
  const stroops = toStroops(sourceAmount);
  const maxStroops = (stroops * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  return fromStroops(maxStroops);
}

export interface BuildPathPaymentInput {
  sourceAccount: string;
  sequence: string;
  destination: string;
  destAsset: AssetRef;
  destAmount: string;
  sendAsset: AssetRef;
  sendMax: string;
  path?: AssetRef[];
  memo?: string | null;
  expiresAt?: number;
  networkPassphrase?: string;
  fee?: string;
}

/**
 * Builds a path_payment_strict_receive transaction matching issue 5.48 specifications:
 * - Single Operation.pathPaymentStrictReceive
 * - sendMax guard protecting against slippage
 * - destination, destAsset, destAmount matching requested payment
 * - preserves memo (correlation reference)
 * - time bounds bounded by quote expiration (minimum 10s timeout)
 */
export function buildPathPayment(input: BuildPathPaymentInput): Transaction {
  const {
    sourceAccount,
    sequence,
    destination,
    destAsset,
    destAmount,
    sendAsset,
    sendMax,
    path = [],
    memo,
    expiresAt,
    networkPassphrase = Networks.TESTNET,
    fee = "10000",
  } = input;

  const builder = new TransactionBuilder(new Account(sourceAccount, sequence), {
    fee,
    networkPassphrase,
  });

  const now = Date.now();
  const timeoutSeconds = expiresAt
    ? Math.max(10, Math.floor((expiresAt - now) / 1000))
    : 300;
  builder.setTimeout(timeoutSeconds);

  builder.addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: toSdkAsset(sendAsset),
      sendMax,
      destination,
      destAsset: toSdkAsset(destAsset),
      destAmount,
      path: path.map(toSdkAsset),
    }),
  );

  if (memo) {
    builder.addMemo(Memo.text(memo));
  }

  return builder.build();
}

export type HorizonPaymentReason =
  | "price_moved"
  | "no_path"
  | "insufficient_balance"
  | "missing_trustline"
  | "payment_rejected";

/**
 * Maps Horizon error result codes to clean payment rejection reasons (issues 2.18 / 5.47).
 * Specifically maps `op_over_source_max` to `price_moved` and `op_too_few_offers` to `no_path`.
 */
export function extractHorizonPaymentReason(err: unknown): HorizonPaymentReason {
  if (typeof err === "object" && err !== null) {
    // If it's already an HttpError with a mapped reason in details
    const details = (err as { details?: { reason?: unknown } }).details;
    if (details && typeof details.reason === "string") {
      const r = details.reason;
      if (
        r === "price_moved" ||
        r === "no_path" ||
        r === "insufficient_balance" ||
        r === "missing_trustline" ||
        r === "payment_rejected"
      ) {
        return r;
      }
    }

    const response = (err as { response?: { data?: unknown } }).response;
    const data = response?.data;
    const resultCodes =
      data && typeof data === "object" && "extras" in data
        ? (data as { extras?: { result_codes?: unknown } }).extras?.result_codes
        : undefined;

    const codes = resultCodes
      ? Object.values(resultCodes as Record<string, unknown>).flatMap((value) =>
          Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string")
            : typeof value === "string"
              ? [value]
              : [],
        )
      : [];

    const upperCodes = codes.map((c) => c.toUpperCase());
    if (upperCodes.some((code) => code.includes("OVER_SOURCE_MAX"))) {
      return "price_moved";
    }
    if (upperCodes.some((code) => code.includes("TOO_FEW_OFFERS"))) {
      return "no_path";
    }
    if (upperCodes.some((code) => code.includes("UNDERFUNDED") || code.includes("LINE_FULL"))) {
      return "insufficient_balance";
    }
    if (upperCodes.some((code) => code.includes("NO_TRUST") || code.includes("NOT_AUTHORIZED"))) {
      return "missing_trustline";
    }
  }

  return "payment_rejected";
}

/** Funds a testnet address via Friendbot with retry on rate limit. */
export async function fundWithFriendbot(address: string, maxRetries = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(address)}`);
    if (res.ok) return;

    const body = await res.text().catch(() => "");
    if (body.includes("createAccountAlreadyExist")) return;

    if (attempt === maxRetries) {
      throw new Error(`Friendbot failed for ${address} (${res.status}): ${body}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

export interface SeedMarketResult {
  issuer: Keypair;
  marketMaker: Keypair;
  usdcAsset: Asset;
}

/**
 * Seeds a synthetic USDC/XLM market on testnet:
 * 1. Creates throwaway issuer
 * 2. Funds a market maker, adds trustline, mints USDC to it
 * 3. Posts manageSellOffer selling USDC for XLM at a fixed price
 */
export async function seedMarket(
  server: { loadAccount: (id: string) => Promise<any>; submitTransaction: (tx: Transaction) => Promise<any> },
  price = "2",
  usdcAmount = "1000",
  offerAmount = "500",
): Promise<SeedMarketResult> {
  const issuer = Keypair.random();
  const marketMaker = Keypair.random();

  await Promise.all([
    fundWithFriendbot(issuer.publicKey()),
    fundWithFriendbot(marketMaker.publicKey()),
  ]);

  const usdcAsset = new Asset("USDC", issuer.publicKey());

  // 1. Establish market maker trustline
  const mmAcc = await server.loadAccount(marketMaker.publicKey());
  const trustTx = new TransactionBuilder(mmAcc, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset }))
    .setTimeout(60)
    .build();
  trustTx.sign(marketMaker);
  await server.submitTransaction(trustTx);

  // 2. Issue USDC to market maker
  const issuerAcc = await server.loadAccount(issuer.publicKey());
  const issueTx = new TransactionBuilder(issuerAcc, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: marketMaker.publicKey(),
        asset: usdcAsset,
        amount: usdcAmount,
      }),
    )
    .setTimeout(60)
    .build();
  issueTx.sign(issuer);
  await server.submitTransaction(issueTx);

  // 3. Market maker posts sell offer on SDEX
  const mmAcc2 = await server.loadAccount(marketMaker.publicKey());
  const offerTx = new TransactionBuilder(mmAcc2, {
    fee: "10000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageSellOffer({
        selling: usdcAsset,
        buying: Asset.native(),
        amount: offerAmount,
        price,
      }),
    )
    .setTimeout(60)
    .build();
  offerTx.sign(marketMaker);
  await server.submitTransaction(offerTx);

  return { issuer, marketMaker, usdcAsset };
}
