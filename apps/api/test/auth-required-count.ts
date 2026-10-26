import { metrics } from "../src/metrics";

/** Current value of `anchor_auth_required_total{route}` (0 when the series has not been written). */
export function authRequiredCount(route: string): number {
  const m = metrics.anchorAuthRequiredTotal.render().match(new RegExp(`anchor_auth_required_total\\{route="${route}"\\} (\\d+)`));
  return m ? Number(m[1]) : 0;
}
