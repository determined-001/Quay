/**
 * Test settings every workspace package shares (issue 8.22).
 *
 * vitest's 5s default is too tight under `turbo run test`: every package suite
 * runs at once, so the slow ones (fast-check property suites, real ed25519
 * SEP-10 signing, the off-ramp poll-backoff waits, happy-dom component mounts)
 * land well past it and fail with `Test timed out in 5000ms` instead of a real
 * assertion. Alone, each of them finishes in a couple of seconds.
 *
 * Spread this into each package's `test:` block so a package that gets slow
 * does not flake first and get a one-off copy of the fix.
 */
export const sharedTest = {
  testTimeout: 10_000,
  hookTimeout: 10_000,
} as const;
