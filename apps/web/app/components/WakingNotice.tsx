"use client";

import { useSlowRequest } from "../../lib/use-slow-request";

/**
 * The one sentence every screen shows while a request to a sleeping API is
 * still out (issue 5.42). Says what is happening; promises no duration.
 */
export const WAKING_COPY = "Starting the payment service. The first request after a quiet spell can take a while.";

export default function WakingNotice({ pending, className }: { pending: boolean; className?: string }) {
  const slow = useSlowRequest(pending);
  if (!slow) return null;
  return (
    <p className={className ?? "muted waking-notice"} role="status">
      {WAKING_COPY}
    </p>
  );
}
