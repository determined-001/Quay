/**
 * Off-ramp mode as the browser sees it. These mirror the API's OFFRAMP setting
 * (see .env.example) so the dashboard never claims a real payout while the
 * backend is still running the simulator.
 *
 * Each value is read through a literal `process.env.NEXT_PUBLIC_*` access:
 * Next only inlines those, so do not refactor these into a lookup by name.
 */

export const OFFRAMP_CURRENCY = process.env.NEXT_PUBLIC_OFFRAMP_CURRENCY ?? "NGN";

/**
 * Only "mock" is simulated. Tested against the mode name rather than
 * `!== "testanchor"`, which was an allowlist of exactly one real backend: it
 * labelled OFFRAMP=anchor, a production anchor moving real money, as
 * "(simulated)", which is the one direction this label must never be wrong in.
 */
export const OFFRAMP_IS_MOCK = (process.env.NEXT_PUBLIC_OFFRAMP_MODE ?? "mock") === "mock";

/**
 * OFFRAMP=none: the deployment takes payments and stops there. Sellers are paid
 * directly on-chain and move their own funds, so there is no cash-out button,
 * no KYC to collect and no modal; the API answers 501 on those routes.
 */
export const OFFRAMP_ENABLED = (process.env.NEXT_PUBLIC_OFFRAMP_MODE ?? "mock") !== "none";

export const CASH_OUT_LABEL = OFFRAMP_IS_MOCK
  ? `Cash out to ${OFFRAMP_CURRENCY} (simulated)`
  : `Cash out to ${OFFRAMP_CURRENCY}`;
