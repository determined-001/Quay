/**
 * Interactive (SEP-24) cash-out step helpers — issue 5.20.
 *
 * Pure functions so the modal's branching decisions (open vs. refuse the
 * anchor URL, what the polled state means in plain words, when to poll next,
 * when to close) are unit-testable without a browser. The component in
 * `app/components/CashOutModal.tsx` drives every interactive-step decision
 * through these.
 */

/** Base poll interval while the interactive step is open. */
export const INTERACTIVE_POLL_MS = 5_000;
/** Backed-off poll interval once the step has been open a while. */
export const INTERACTIVE_POLL_SLOW_MS = 30_000;
/** Elapsed time after which polling backs off from base to slow. */
export const INTERACTIVE_POLL_SLOW_AFTER_MS = 2 * 60_000;

export type ParsedInteractiveUrl =
  { ok: true; href: string } | { ok: false; error: string };

/**
 * Validates an anchor-supplied interactive URL.
 *
 * `url` is third-party data — it comes from the anchor, through our API, and
 * lands in a DOM sink. Anything but https is refused: `javascript:` in
 * `window.open` would execute against this page, and plain http would
 * downgrade a flow the seller is about to enter bank details into.
 */
export function parseInteractiveUrl(url: string): ParsedInteractiveUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      error:
        "The anchor returned an unusable interactive URL. Contact support before retrying.",
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      error:
        "The anchor returned a non-HTTPS interactive URL, which was refused.",
    };
  }
  return { ok: true, href: parsed.href };
}

/**
 * Display label for the "Continue with …" button: the host the seller will
 * land on. Hostname, not a marketing name — it is the only thing we know
 * about the anchor's page, and showing it keeps the destination honest.
 */
export function anchorLabelForUrl(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return "the anchor";
  }
}

/**
 * Anchor-reported external status in plain words for the seller. `incomplete`
 * is the SEP-24 "waiting on you" state — the seller closed or never finished
 * the anchor's window — so it names the next action instead of the jargon.
 */
export function describeInteractiveStatus(
  externalStatus: string | null | undefined,
): string {
  switch (externalStatus) {
    case "incomplete":
      return "Waiting for you to finish in the anchor's window.";
    case "pending_user_transfer_start":
      return "Anchor is ready — send the asset from your wallet to continue.";
    case "pending_user_transfer_complete":
      return "Transfer sent — the anchor is confirming it.";
    case "pending_external":
      return "Anchor is waiting on an external payment rail.";
    case "pending_anchor":
      return "Anchor is processing your withdrawal.";
    case "pending_trust":
      return "Anchor is waiting for a trustline.";
    case "pending_user":
      return "Anchor is waiting on you.";
    case "pending_customer_info_update":
      return "Anchor needs more information from you.";
    case null:
    case undefined:
      return "Waiting for the anchor…";
    default:
      return `Anchor status: ${externalStatus}.`;
  }
}

/**
 * Delay before the next `GET /links/:id/detail` poll. Steady 5 s cadence,
 * backing off to 30 s after the step has been open 2 minutes so a forgotten
 * tab doesn't hammer the API forever.
 */
export function interactivePollDelayMs(elapsedMs: number): number {
  if (elapsedMs >= INTERACTIVE_POLL_SLOW_AFTER_MS)
    return INTERACTIVE_POLL_SLOW_MS;
  return INTERACTIVE_POLL_MS;
}

/**
 * Whether the polled link state closes the interactive step with success.
 * Only terminal `offrampStatus` values count — anything else keeps polling
 * (or waits for the seller to dismiss).
 */
export function isInteractiveTerminalStatus(
  offrampStatus: string | null | undefined,
): boolean {
  return offrampStatus === "settled" || offrampStatus === "failed";
}
