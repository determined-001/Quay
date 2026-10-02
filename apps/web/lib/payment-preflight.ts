import { fromStroops, toStroops } from "@checkout/core";

export const BASE_FEE_STROOPS = 100n;
export const BASE_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM

export interface AccountBalanceEntry {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

export interface MinimalStellarAccount {
  balances: AccountBalanceEntry[];
  subentry_count?: number;
}

export interface PaymentAssetSpec {
  code: string;
  issuer: string | null;
}

export type PaymentPreflightStatus =
  | "ok"
  | "account_not_funded"
  | "wrong_wallet"
  | "missing_trustline"
  | "insufficient_balance"
  | "insufficient_fee";

export interface PaymentPreflightOk {
  ok: true;
}

export interface PaymentPreflightFail {
  ok: false;
  reason: Exclude<PaymentPreflightStatus, "ok">;
  message: string;
  requiredAmount?: string;
  availableBalance?: string;
  assetCode: string;
  requiredFee?: string;
  availableXlm?: string;
}

export type PaymentPreflightResult = PaymentPreflightOk | PaymentPreflightFail;

export interface PreflightOptions {
  connectedAddress?: string | null;
  expectedAddress?: string | null;
  feeStroops?: bigint;
}

/**
 * Validates whether an account can make a Stellar payment:
 * 1. Checks matching connected address vs expected address (if provided).
 * 2. Checks account is loaded/funded.
 * 3. Checks trustline exists for non-native assets.
 * 4. Checks asset balance (accounting for base reserve when asset is native XLM).
 * 5. Checks XLM fee balance.
 */
export function checkPaymentPreflight(
  account: MinimalStellarAccount | null | undefined,
  asset: PaymentAssetSpec,
  amount: string | bigint,
  options?: PreflightOptions,
): PaymentPreflightResult {
  const assetCode = asset.code || (asset.issuer === null ? "XLM" : "unknown");

  if (
    options?.connectedAddress &&
    options?.expectedAddress &&
    options.connectedAddress.trim().toUpperCase() !== options.expectedAddress.trim().toUpperCase()
  ) {
    return {
      ok: false,
      reason: "wrong_wallet",
      message: "The connected wallet does not match your registered seller wallet.",
      assetCode,
    };
  }

  if (!account || !Array.isArray(account.balances) || account.balances.length === 0) {
    return {
      ok: false,
      reason: "account_not_funded",
      message: "This wallet is not funded on the selected network.",
      assetCode,
    };
  }

  const amountStroops = typeof amount === "bigint" ? amount : toStroops(amount);
  if (amountStroops <= 0n) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: "Payment amount must be greater than zero.",
      assetCode,
      requiredAmount: fromStroops(amountStroops),
      availableBalance: "0",
    };
  }

  const fee = options?.feeStroops ?? BASE_FEE_STROOPS;
  const isNative = asset.issuer === null || asset.code === "XLM" && !asset.issuer;

  const nativeEntry = account.balances.find((entry) => entry.asset_type === "native");
  const nativeAvailableStroops = nativeEntry ? toStroops(nativeEntry.balance) : 0n;

  if (isNative) {
    // Native payment: must have fee and account minimum reserve
    const subentries =
      account.subentry_count ??
      (account.balances.length > 0 ? account.balances.length - 1 : 0);
    const minimumReserve = BigInt(2 + subentries) * BASE_RESERVE_STROOPS;
    const requiredTotal = amountStroops + fee + minimumReserve;

    if (nativeAvailableStroops < fee) {
      return {
        ok: false,
        reason: "insufficient_fee",
        message: "This wallet does not have enough XLM for the network fee.",
        assetCode,
        requiredFee: fromStroops(fee),
        availableXlm: fromStroops(nativeAvailableStroops),
      };
    }

    if (nativeAvailableStroops < minimumReserve + fee) {
      return {
        ok: false,
        reason: "insufficient_fee",
        message: "This wallet does not have enough XLM for the minimum reserve and network fee.",
        assetCode,
        requiredFee: fromStroops(minimumReserve + fee),
        availableXlm: fromStroops(nativeAvailableStroops),
      };
    }

    const sendableNativeStroops =
      nativeAvailableStroops > minimumReserve + fee
        ? nativeAvailableStroops - minimumReserve - fee
        : 0n;

    if (nativeAvailableStroops < requiredTotal) {
      return {
        ok: false,
        reason: "insufficient_balance",
        message: `You need ${fromStroops(amountStroops)} ${assetCode}, this wallet has ${fromStroops(sendableNativeStroops)}.`,
        assetCode,
        requiredAmount: fromStroops(amountStroops),
        availableBalance: fromStroops(sendableNativeStroops),
      };
    }

    return { ok: true };
  }

  // Non-native asset (e.g. USDC)
  const assetEntry = account.balances.find(
    (entry) =>
      (entry.asset_type === "credit_alphanum4" || entry.asset_type === "credit_alphanum12") &&
      entry.asset_code === asset.code &&
      entry.asset_issuer === asset.issuer,
  );

  if (!assetEntry) {
    return {
      ok: false,
      reason: "missing_trustline",
      message: `This wallet has no ${assetCode} trustline.`,
      assetCode,
    };
  }

  const assetAvailableStroops = toStroops(assetEntry.balance);
  if (assetAvailableStroops < amountStroops) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: `You need ${fromStroops(amountStroops)} ${assetCode}, this wallet has ${fromStroops(assetAvailableStroops)}.`,
      assetCode,
      requiredAmount: fromStroops(amountStroops),
      availableBalance: fromStroops(assetAvailableStroops),
    };
  }

  if (!nativeEntry || nativeAvailableStroops < fee) {
    return {
      ok: false,
      reason: "insufficient_fee",
      message: "This wallet does not have enough XLM for the network fee.",
      assetCode,
      requiredFee: fromStroops(fee),
      availableXlm: fromStroops(nativeAvailableStroops),
    };
  }

  return { ok: true };
}

/**
 * Maps Horizon submit error result codes into structured reasons.
 */
export function horizonPaymentReason(
  err: unknown,
): "insufficient_balance" | "missing_trustline" | "payment_rejected" {
  const e = err as {
    response?: { data?: unknown };
    data?: unknown;
    extras?: { result_codes?: unknown };
  };
  const data = e?.response?.data ?? e?.data ?? (e && typeof e === "object" && "extras" in e ? e : undefined);
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
  if (
    upperCodes.some(
      (code) =>
        code.includes("UNDERFUNDED") ||
        code.includes("LINE_FULL") ||
        code.includes("INSUFFICIENT_FEE") ||
        code.includes("LOW_RESERVE"),
    )
  ) {
    return "insufficient_balance";
  }
  if (
    upperCodes.some(
      (code) =>
        code.includes("NO_TRUST") ||
        code.includes("NOT_AUTHORIZED") ||
        code.includes("NO_ISSUER"),
    )
  ) {
    return "missing_trustline";
  }
  return "payment_rejected";
}
