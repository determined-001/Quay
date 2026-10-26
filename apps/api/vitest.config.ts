import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
import { sharedTest } from "../../vitest.shared";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 75, statements: 73, functions: 72, branches: 66 }),
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // `src/env.ts` calls loadEnvFiles() at import time, walking up to the
    // nearest .env — so without this the suite runs against whatever the
    // developer happens to have configured locally. A realistic .env
    // (OFFRAMP=testanchor, no KYC_ENCRYPTION_KEY) made every test that
    // transitively imports env.ts throw `Missing required env var:
    // KYC_ENCRYPTION_KEY`, while CI — which has no .env at all and therefore
    // defaults to OFFRAMP=mock — stayed green. Pinning the values here makes a
    // local run reproduce CI instead of the developer's machine.
    env: {
      STELLAR_NETWORK: "testnet",
      OFFRAMP: "mock",
      KYC_ENCRYPTION_KEY: "0".repeat(64),
    },
    ...sharedTest,
  },
});
