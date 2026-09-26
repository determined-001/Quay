import { defineConfig, devices } from "@playwright/test";
import { LOCAL_API_URL, LOCAL_WEB_URL, isLiveRun, liveWebUrl } from "./e2e/urls";

/**
 * Two suites, one config (issue 5.7):
 *
 *   `pnpm e2e`       → project `local`: boots API + web on their own ports
 *                      (8788/3100, never clashing with `pnpm dev`) with an
 *                      in-memory database and E2E_TEST_MODE=1, and runs the
 *                      whole payment loop with no network access.
 *   `pnpm e2e:live`  → project `live`: boots nothing; asserts the deployed
 *                      demo's stranger path and scans it for placeholder
 *                      strings. `pnpm sweep` runs this after the uptime check.
 *
 * `webServer` and `globalSetup` are only valid at the TOP level of this
 * config (nesting them in a `projects[]` entry is a TS2769 build error), so
 * booting-vs-not is expressed by gating the top-level `webServer` on how the
 * run was invoked (see `isLiveRun`).
 */
const IS_LIVE = isLiveRun();

export default defineConfig({
  testDir: "./e2e",
  // A CI box or a laptop mid-`pnpm dev` is slow to first-compile Next pages;
  // per-test time buys headroom without hiding a hang forever.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: the local suite shares one API process and one in-memory
  // database, and the live suite should look like one visitor, not a scrape.
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: IS_LIVE ? liveWebUrl() : LOCAL_WEB_URL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "local", testDir: "./e2e/local", use: { ...devices["Desktop Chrome"] } },
    { name: "live", testDir: "./e2e/live", use: { ...devices["Desktop Chrome"] } },
  ],
  // A bare `playwright test` (no --project) must not quietly hit the deployed
  // site from a PR run: everything under e2e/live is tagged @live and
  // filtered out unless this is an explicit live invocation.
  grepInvert: IS_LIVE ? undefined : /@live/,
  webServer: IS_LIVE
    ? undefined
    : [
        {
          // `tsx src/index.ts` (the package's own `start`), not `dev`: watch
          // mode restarts on stray file events, which under a test runner is
          // flakiness with no upside.
          command: "pnpm --filter @checkout/api exec tsx src/index.ts",
          url: `${LOCAL_API_URL}/ready`,
          // Cold tsx start measured ~20s on a dev machine and slower on a
          // loaded CI runner — 30s was too tight in practice.
          timeout: 90_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            API_PORT: "8788",
            E2E_TEST_MODE: "1",
            STELLAR_NETWORK: "testnet",
            // Private to this one process; vanishes with it. Nothing to
            // clean up and nothing a parallel `pnpm dev` could collide with.
            DATABASE_URL: ":memory:",
            OFFRAMP: "mock",
            // The checkout page polls the API from the browser at :3100.
            CORS_ORIGINS: LOCAL_WEB_URL,
            COOKIE_SECURE: "false",
            // Cash-out poller runs at max(3000, this) — keep settlement
            // assertions fast.
            WATCH_POLL_MS: "1000",
            // Deterministic seeded seller instead of a generated throwaway
            // keypair (nothing looks this wallet up in test mode).
            DEFAULT_SELLER_WALLET: "GB4UZMDW2P4WITZ3DFPFIU6B7NRHBDDP5UQ2BUENI3LJQOX2YC2U7FJB",
            DEFAULT_SELLER_NAME: "E2E Seller",
          },
        },
        {
          command: "pnpm --filter @checkout/web exec next dev -p 3100",
          url: LOCAL_WEB_URL,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            NEXT_PUBLIC_API_URL: LOCAL_API_URL,
            API_URL: LOCAL_API_URL,
            NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
            NEXT_PUBLIC_OFFRAMP_MODE: "mock",
            NEXT_PUBLIC_OFFRAMP_CURRENCY: "NGN",
            NEXT_TELEMETRY_DISABLED: "1",
          },
        },
      ],
});
