"use client";

import { useEffect } from "react";
import { apiBase } from "../../lib/api";

/**
 * Sends one GET /health after the landing page has painted (issue 5.42), so a
 * sleeping API starts waking while the visitor reads. Never blocks, never
 * retries, never surfaces an error.
 */
export default function ApiWarmUp() {
  useEffect(() => {
    try {
      void fetch(`${apiBase()}/health`, { keepalive: true }).catch(() => {});
    } catch {
      // No API URL configured, or fetch unavailable: warming is best-effort.
    }
  }, []);
  return null;
}
