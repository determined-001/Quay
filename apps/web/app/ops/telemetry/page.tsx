import type { Metadata } from 'next';
import TelemetryClient from './telemetry-client';

/**
 * Operator-only corridor telemetry view (issue 5.21). Deliberately outside
 * the seller navigation — nothing links here — and noindexed: it is an ops
 * tool gated by TELEMETRY_TOKEN, not a product surface.
 */
export const metadata: Metadata = {
  title: 'Corridor telemetry · Quay ops',
  robots: { index: false, follow: false },
};

export default function OpsTelemetryPage() {
  return <TelemetryClient />;
}
