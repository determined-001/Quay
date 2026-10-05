// Exact decimal arithmetic for the no-SEP-38 quote (issue 3.22).
//
// Money never goes through binary floats here. Every input is parsed into an
// exact rational (BigInt numerator/denominator), the quote is computed
// exactly, and only the final figures are rounded to TARGET_SCALE places — in
// the direction that can never show the seller more than they will get:
// net rounds DOWN, fee rounds UP, and gross is defined as net + fee so the
// three displayed figures always add up.

const TARGET_SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(TARGET_SCALE);

interface Frac {
  n: bigint;
  d: bigint;
}

/** Parses "12", "12.5", "1e-7", "1.5E3" (also what String(number) yields) exactly. */
export function parseDecimal(input: string | number): Frac {
  const s = String(input).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal number: "${s}"`);
  const [, sign, intPart, fracPart = "", exp = "0"] = m;
  let n = BigInt(intPart! + fracPart);
  const e = Number(exp) - fracPart.length;
  if (Math.abs(e) > 60) throw new Error(`decimal exponent out of range: "${s}"`);
  let d = 1n;
  if (e >= 0) n *= 10n ** BigInt(e);
  else d = 10n ** BigInt(-e);
  if (sign === "-") n = -n;
  return { n, d };
}

const mul = (a: Frac, b: Frac): Frac => ({ n: a.n * b.n, d: a.d * b.d });
const add = (a: Frac, b: Frac): Frac => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });

/** floor(a * SCALE) as an integer count of 1e-TARGET_SCALE units (d is always > 0). */
function floorUnits(a: Frac): bigint {
  const num = a.n * SCALE_FACTOR;
  let q = num / a.d; // truncates toward zero
  if (num % a.d !== 0n && num < 0n) q -= 1n;
  return q;
}
function ceilUnits(a: Frac): bigint {
  return -floorUnits({ n: -a.n, d: a.d });
}

function format(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(TARGET_SCALE, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export type IndicativeAmounts =
  | { ok: true; targetAmount: string; feeAmount: string; netTargetAmount: string }
  | { ok: false; reason: "non_positive_net" | "zero_quote" };

/**
 *   fee = (feeFixed + amount × feePercent/100) × rate     (fees are in the SELL asset)
 *   net = amount × rate − fee
 *
 * Returns `ok: false` rather than a figure when the seller would receive
 * nothing: a fee at or above the amount, or a rate so small the rounded net is
 * zero. Absent fee fields mean no fee.
 */
export function computeIndicativeAmounts(input: {
  amount: string;
  rate: string;
  feeFixed?: number | undefined;
  feePercent?: number | undefined;
}): IndicativeAmounts {
  const amount = parseDecimal(input.amount);
  const rate = parseDecimal(input.rate);
  const feeFixed = parseDecimal(input.feeFixed ?? 0);
  const feePct = parseDecimal(input.feePercent ?? 0);

  const feeSell = add(feeFixed, mul(mul(amount, feePct), { n: 1n, d: 100n }));
  const fee = mul(feeSell, rate);
  const gross = mul(amount, rate);
  const net = add(gross, { n: -fee.n, d: fee.d });

  if (net.n <= 0n) return { ok: false, reason: "non_positive_net" };
  const netUnits = floorUnits(net);
  if (netUnits <= 0n) return { ok: false, reason: "zero_quote" };
  const feeUnits = ceilUnits(fee);
  return {
    ok: true,
    netTargetAmount: format(netUnits),
    feeAmount: format(feeUnits),
    // Defined as net + fee so the three figures reconcile exactly.
    targetAmount: format(netUnits + feeUnits),
  };
}
