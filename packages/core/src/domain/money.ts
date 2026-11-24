// Fixed-point money math for Stellar amounts.
// Stellar amounts have at most 7 decimal places ("stroops" = 1e-7).
// We never compare these as floats — we convert to integer stroops (BigInt).

export const STELLAR_DECIMALS = 7;

/** Maximum Stellar amount: (2^63 - 1) stroops = 922337203685.4775807. */
export const MAX_AMOUNT = "922337203685.4775807";
export const MAX_STROOPS = 9_223_372_036_854_775_807n; // 2n ** 63n - 1n

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

export function isValidAmount(amount: string): boolean {
  return AMOUNT_RE.test(amount.trim());
}

/** Check if amount is valid, strictly positive, and does not exceed maximum Stellar stroops. */
export function isPositiveAmount(amount: string): boolean {
  if (!isValidAmount(amount)) return false;
  const stroops = toStroops(amount);
  return stroops > 0n && stroops <= MAX_STROOPS;
}

/** Convert a decimal amount string ("12.3456789") to integer stroops (BigInt). */
export function toStroops(amount: string): bigint {
  const a = amount.trim();
  if (!AMOUNT_RE.test(a)) {
    throw new Error(`Invalid Stellar amount: "${amount}"`);
  }
  const [whole = "0", frac = ""] = a.split(".");
  const fracPadded = (frac + "0000000").slice(0, STELLAR_DECIMALS);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded || "0");
}

/** Normalize an amount string to a canonical 7-dp-trimmed form ("10.5", "10"). */
export function normalizeAmount(amount: string): string {
  const stroops = toStroops(amount);
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole}`;
}

export function fromStroops(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole}`;
}

export type AmountComparison = "exact" | "over" | "under";

/** Compare a received amount against an expected amount, in stroops. */
export function compareAmount(
  received: string,
  expected: string,
): AmountComparison {
  const r = toStroops(received);
  const e = toStroops(expected);
  if (r === e) return "exact";
  return r > e ? "over" : "under";
}

/** Multiply integer stroops by an integer quantity. Throws if negative or exceeds MAX_STROOPS. */
export function mulStroops(stroops: bigint, quantity: number | bigint): bigint {
  const q = typeof quantity === "bigint" ? quantity : BigInt(quantity);
  if (q < 0n || stroops < 0n) {
    throw new Error("Cannot multiply negative stroops or quantity");
  }
  const result = stroops * q;
  if (result > MAX_STROOPS) {
    throw new Error(`Amount exceeds maximum Stellar stroops: ${result} > ${MAX_STROOPS}`);
  }
  return result;
}

/** Sum an array of integer stroops. Throws if any negative or sum exceeds MAX_STROOPS. */
export function sumStroops(stroopsList: bigint[]): bigint {
  let sum = 0n;
  for (const s of stroopsList) {
    if (s < 0n) {
      throw new Error("Cannot sum negative stroops");
    }
    sum += s;
    if (sum > MAX_STROOPS) {
      throw new Error(`Total exceeds maximum Stellar stroops: ${sum} > ${MAX_STROOPS}`);
    }
  }
  return sum;
}
