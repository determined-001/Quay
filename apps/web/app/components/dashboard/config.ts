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

/**
 * Refunds are off unless the deployment turns them on (issue 8.29). The API
 * answers 501 `refunds_disabled` on every refund route while REFUNDS_ENABLED
 * is off, so the dashboard must not offer a button the backend will refuse.
 *
 * Default off matters here more than elsewhere: a refund is a real payment out
 * of the seller's wallet, so "not yet configured" must never mean "on".
 *
 * Literal access, for the same reason as the values above: Next inlines only a
 * literal `process.env.NEXT_PUBLIC_*` read at build time. A computed lookup
 * (`process.env[name]`) is not inlined, leaves this `undefined` in the browser
 * bundle, and the feature could never be turned on in production.
 */
export const REFUNDS_ENABLED =
  process.env.NEXT_PUBLIC_REFUNDS_ENABLED === "1" ||
  process.env.NEXT_PUBLIC_REFUNDS_ENABLED === "true";

export const CASH_OUT_LABEL = OFFRAMP_IS_MOCK
  ? `Cash out to ${OFFRAMP_CURRENCY} (simulated)`
  : `Cash out to ${OFFRAMP_CURRENCY}`;

export const INVOICES_ENABLED = process.env.NEXT_PUBLIC_INVOICES_ENABLED === "true";

