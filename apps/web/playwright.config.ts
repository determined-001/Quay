import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Distinct from the normal dev ports (3000 / 8787) so this suite can run
// alongside a `pnpm dev` already running locally without a port clash.
const LOCAL_WEB_PORT = 3100;
const LOCAL_API_PORT = 8887;
const LOCAL_WEB_URL = `http://localhost:${LOCAL_WEB_PORT}`;
const LOCAL_API_URL = `http://localhost:${LOCAL_API_PORT}`;

// Playwright takes `webServer` and `globalSetup` at the top level only — they
// are not per-project options. The live suite must NOT boot local servers, so
// both are switched off when running it. `pnpm e2e:live` / `pnpm sweep` set
// E2E_LIVE=1; the local suite leaves it unset.
const IS_LIVE = process.env.E2E_LIVE === "1";

export default defineConfig({
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Both e2e projects share one running API instance per run (and, for
  // "local", one in-process DB file) - keeping this false trades away
  // intra-file parallelism for not having to reason about concurrent tests
  // racing the same seeded state.
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  webServer: IS_LIVE ? undefined : [
    {
      command: "pnpm --filter @checkout/api start",
      cwd: repoRoot,
      url: `${LOCAL_API_URL}/health`,
      reuseExistingServer: false,
      // The API starts through tsx with no build step, so a cold start is
      // ~20s on a warm machine and slower on a loaded CI runner. 30s was
      // marginal enough to fail intermittently.
      timeout: 90_000,
      env: {
        API_PORT: String(LOCAL_API_PORT),
        // A file DB, not :memory: - unverified whether @libsql/client's
        // in-memory mode behaves identically to a file for this repo's
        // exact usage, and a throwaway file is just as fast for this
        // suite's scale. Gitignored (**/*.db); deleted before each run
        // by ./e2e/global-setup.ts so every run starts from empty.
        DATABASE_URL: "file:./e2e-test.db",
        STELLAR_NETWORK: "testnet",
        OFFRAMP: "mock",
        OFFRAMP_MOCK_SETTLE_MS: "500",
        E2E_TEST_MODE: "1",
        CORS_ORIGINS: LOCAL_WEB_URL,
        RATE_LIMIT_MAX: "0",
      },
    },
    {
      command: "pnpm --filter @checkout/web e2e:dev",
      cwd: repoRoot,
      url: LOCAL_WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NEXT_PUBLIC_API_URL: LOCAL_API_URL,
        API_URL: LOCAL_API_URL,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
  globalSetup: IS_LIVE ? undefined : "./e2e/global-setup.ts",
  projects: [
    {
      // The full payment loop against a locally-composed stack (issue 5.7,
      // point 1) - fake off-ramp settle timing, no live Stellar network. Runs
      // on every PR (.github/workflows/ci.yml) and must work with zero
      // network access: the real ledger watcher is disabled via
      // E2E_TEST_MODE (see apps/api/src/services/container.ts), and payments
      // are settled through a test-only route instead of waiting for one to
      // land on-chain.
      name: "local",
      testDir: "./e2e/local",
      use: { baseURL: LOCAL_WEB_URL, ...devices["Desktop Chrome"] },
    },
    {
      // Against the real deployed URLs (issue 5.7, point 2) - genuinely
      // exercises the stranger path: /ready is green, link creation from a
      // clean browser context, checkout renders a QR. Run nightly/on-demand
      // (.github/workflows/e2e-live.yml) and via `pnpm sweep` - never on
      // every PR, since it depends on and mutates the live deployment.
      name: "live",
      testDir: "./e2e/live",
      use: {
        baseURL: process.env.LIVE_WEB_URL ?? "https://quay-web.vercel.app",
        ...devices["Desktop Chrome"],
      },
      // No webServer - this project talks to whatever is already deployed.
    },
  ],
});
