"use client";

import { useEffect, useState } from "react";

/** How long a request may run before the UI says the service is waking up (issue 5.42). */
export const SLOW_REQUEST_MS = 5_000;

/**
 * True once `pending` has stayed true for `thresholdMs` (issue 5.42). The
 * mainnet API sleeps when idle and its first request can take tens of
 * seconds; this lets a screen say so instead of looking frozen. It resets as
 * soon as `pending` goes false.
 */
export function useSlowRequest(pending: boolean, thresholdMs = SLOW_REQUEST_MS): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), thresholdMs);
    return () => clearTimeout(timer);
  }, [pending, thresholdMs]);

  return slow;
}
