/**
 * Pure figures behind the seller's Home page. Everything here is derived from
 * the list of payment links already on screen, so a total can never disagree
 * with the rows beneath it, and nothing needs a new API route.
 *
 * Two honest limits, both repeated where the numbers are shown:
 *
 *  - Only USDC is added up. Mixing assets into one number would be wrong.
 *  - The API does not yet expose a "paid at" time. The link detail page
 *    already treats `updatedAt` as the paid time, and so do these figures. It
 *    is exact while a link sits at `paid` and moves forward when a cash-out
 *    touches the link, so a date-bounded total is a close estimate, not a
 *    ledger. All-time totals are exact.
 */

import type { PaymentLink } from "./api";

/** Statuses where the buyer has paid in full, so the money is the seller's. */
export const PAID_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "offramp_pending",
  "offramp_settled",
  "offramp_failed",
]);

/** Statuses where the seller can start (or retry) a cash-out. */
export const CASHABLE_STATUSES: ReadonlySet<string> = new Set(["paid", "offramp_failed"]);

const DAY_MS = 86_400_000;

const isUsdc = (l: PaymentLink): boolean => l.asset.code === "USDC";

/** What the seller actually received for a link (an overpayment counts). */
function received(l: PaymentLink): number {
  const n = Number(l.paidAmount ?? l.amount);
  return Number.isFinite(n) ? n : 0;
}

export type RangeKey = "7d" | "30d" | "all";

export const RANGE_LABEL: Record<RangeKey, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

/** USDC received, optionally only for payments last touched since `since` (epoch ms). */
export function totalReceived(links: PaymentLink[], since?: number): number {
  return links
    .filter((l) => PAID_STATUSES.has(l.status) && isUsdc(l) && (since === undefined || l.updatedAt >= since))
    .reduce((sum, l) => sum + received(l), 0);
}

/** Start (epoch ms) of the window a range key covers, ending now. */
export function rangeStart(range: RangeKey, now: number): number | undefined {
  if (range === "all") return undefined;
  return startOfLocalDay(now) - (range === "7d" ? 6 : 29) * DAY_MS;
}

export function readyToCashOut(links: PaymentLink[]): { amount: number; count: number } {
  const ready = links.filter((l) => CASHABLE_STATUSES.has(l.status) && isUsdc(l));
  return { amount: ready.reduce((s, l) => s + received(l), 0), count: ready.length };
}

export function awaitingPayment(links: PaymentLink[]): { count: number; amount: number } {
  const open = links.filter((l) => l.status === "active");
  return {
    count: open.length,
    amount: open.filter(isUsdc).reduce((s, l) => s + Number(l.amount || 0), 0),
  };
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface DayBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  key: string;
  /** Local midnight, epoch ms. */
  start: number;
  total: number;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** One bucket per local calendar day for the last `days` days, oldest first, today last. */
export function dailySeries(links: PaymentLink[], days: number, now: number): DayBucket[] {
  const buckets: DayBucket[] = [];
  const today = new Date(startOfLocalDay(now));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({ key: dayKey(d.getTime()), start: d.getTime(), total: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const l of links) {
    if (!PAID_STATUSES.has(l.status) || !isUsdc(l)) continue;
    const bucket = byKey.get(dayKey(l.updatedAt));
    if (bucket) bucket.total += received(l);
  }
  return buckets;
}

// ── Words, not codes ────────────────────────────────────────────────────────

export type Tone = "ok" | "wait" | "bad" | "idle";

export interface HumanStatus {
  label: string;
  tone: Tone;
}

/** The status a business owner reads, in place of the machine value. */
export function humanStatus(link: Pick<PaymentLink, "status" | "offrampStatus">): HumanStatus {
  switch (link.status) {
    case "active":
      return { label: "Waiting for payment", tone: "wait" };
    case "underpaid":
      return { label: "Part paid", tone: "wait" };
    case "paid":
      return { label: "Paid", tone: "ok" };
    case "offramp_pending":
      return link.offrampStatus === "awaiting_transfer"
        ? { label: "Waiting for your transfer", tone: "wait" }
        : { label: "Cashing out", tone: "wait" };
    case "offramp_settled":
      return { label: "Cashed out", tone: "ok" };
    case "offramp_failed":
      return { label: "Cash-out failed", tone: "bad" };
    case "expired":
      return { label: "Expired", tone: "idle" };
    case "cancelled":
      return { label: "Cancelled", tone: "idle" };
    default: {
      const raw = String(link.status).replace(/_/g, " ");
      return { label: raw.charAt(0).toUpperCase() + raw.slice(1), tone: "idle" };
    }
  }
}

/** "Just now", "12 min ago", "3 h ago", "Yesterday", "4 days ago", then a date. */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return "Just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24 && startOfLocalDay(ts) === startOfLocalDay(now)) return `${hours} h ago`;
  const daysApart = Math.round((startOfLocalDay(now) - startOfLocalDay(ts)) / DAY_MS);
  if (daysApart === 1) return "Yesterday";
  if (daysApart < 7) return `${daysApart} days ago`;
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** `$1,240.00`. USDC is a dollar token, so it reads as dollars. */
export function formatDollars(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/** `₦1,672,000` for NGN and the matching symbol for other ISO codes, with no decimals. */
export function formatFiat(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString("en")} ${currency}`;
  }
}

/** The row amount: dollars for USDC, `10 XLM` for anything else. */
export function formatLinkAmount(link: Pick<PaymentLink, "amount" | "paidAmount" | "asset" | "status">): string {
  const value = PAID_STATUSES.has(link.status) ? (link.paidAmount ?? link.amount) : link.amount;
  const n = Number(value);
  if (link.asset.code === "USDC" && Number.isFinite(n)) return formatDollars(n);
  return `${value} ${link.asset.code}`;
}

// ── Filters for the Payments page ───────────────────────────────────────────

export type PaymentFilter = "all" | "waiting" | "paid" | "cashout" | "closed";

export const FILTER_LABEL: Record<PaymentFilter, string> = {
  all: "All",
  waiting: "Waiting",
  paid: "Paid",
  cashout: "Cash-out",
  closed: "Expired or cancelled",
};

export function matchesFilter(link: Pick<PaymentLink, "status">, filter: PaymentFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "waiting":
      return link.status === "active" || link.status === "underpaid";
    case "paid":
      return link.status === "paid";
    case "cashout":
      return link.status.startsWith("offramp_");
    case "closed":
      return link.status === "expired" || link.status === "cancelled";
  }
}

export function filterCounts(links: Pick<PaymentLink, "status">[]): Record<PaymentFilter, number> {
  const counts: Record<PaymentFilter, number> = { all: 0, waiting: 0, paid: 0, cashout: 0, closed: 0 };
  for (const l of links) {
    for (const f of Object.keys(counts) as PaymentFilter[]) {
      if (matchesFilter(l, f)) counts[f] += 1;
    }
  }
  return counts;
}

// ── Getting started ─────────────────────────────────────────────────────────

export interface SetupStep {
  id: "wallet" | "usdc" | "link" | "payment" | "verify";
  label: string;
  done: boolean;
}

export function setupSteps(input: {
  links: Pick<PaymentLink, "status">[];
  /** null while unknown (still loading); false when the wallet cannot receive USDC. */
  canReceiveUsdc: boolean | null;
  /** Only set when a real anchor is configured and identity checks apply. */
  verification?: { accepted: boolean };
}): SetupStep[] {
  const steps: SetupStep[] = [
    { id: "wallet", label: "Connect your wallet", done: true },
    { id: "usdc", label: "Make sure your wallet can receive USDC", done: input.canReceiveUsdc === true },
    { id: "link", label: "Create your first payment link", done: input.links.length > 0 },
    { id: "payment", label: "Get your first payment", done: input.links.some((l) => PAID_STATUSES.has(l.status)) },
  ];
  if (input.verification) {
    steps.push({ id: "verify", label: "Verify your identity to cash out", done: input.verification.accepted });
  }
  return steps;
}
