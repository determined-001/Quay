import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 52, statements: 51, functions: 45, branches: 51 }),
    include: ["test/**/*.test.ts"],
    // anchor-session.test.ts signs real SEP-10 challenges (ed25519). Alone the
    // slowest lands under 1s, but under `turbo run test` every package suite
    // runs concurrently and it blew through vitest's 5s default. Same reasoning,
    // and same value, as packages/core and apps/api.
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
