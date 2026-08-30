import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The fast-check property suites run hundreds of cases each. In isolation
    // the slowest lands around 1.7s, but under `turbo run test` all six package
    // suites execute concurrently and they reliably blow through vitest's 5s
    // default — surfacing as `Test timed out in 5000ms` on two random property
    // tests rather than as a counterexample. Same reasoning, and same value, as
    // apps/api/vitest.config.ts.
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
