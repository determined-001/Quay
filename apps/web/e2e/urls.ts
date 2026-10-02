/**
 * One place for every URL the e2e suite talks to, imported by both
 * playwright.config.ts and the specs (workers re-evaluate the config in their
 * own process, so a value computed there cannot simply be handed to a spec —
 * shared derivation beats shared state).
 *
 * Local: the config's webServer entries boot the API and web app on their own
 * ports (8788/3100), deliberately NOT 8787/3000, so a `pnpm dev` session and
 * the e2e suite never fight over a port.
 *
 * Live: the deployed testnet demo, overridable for a fork or a staging
 * deployment. NEVER point these at a mainnet deployment — the live suite is
 * read-only, but the pre-entry ritual is about the demo surface.
 */
export const LOCAL_API_URL = "http://localhost:8788";
export const LOCAL_WEB_URL = "http://localhost:3100";

// `?? default` alone is wrong here: an unset GitHub Actions *variable*
// arrives as an empty string, not undefined, and an empty baseURL fails in a
// way that names nothing.
function envOr(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

export function liveApiUrl(): string {
  return envOr("E2E_LIVE_API_URL", "https://quay-api.onrender.com");
}

export function liveWebUrl(): string {
  return envOr("E2E_LIVE_WEB_URL", "https://quay-web.vercel.app");
}

/** True when this invocation targets the deployed site (`--project=live`,
 *  as `pnpm e2e:live` and `pnpm sweep` run it) — the config then boots no
 *  local servers. */
export function isLiveRun(): boolean {
  if (process.env.E2E_LIVE === "1") return true;
  const argv = process.argv;
  return argv.some(
    (arg, i) => arg === "--project=live" || (arg === "--project" && argv[i + 1] === "live"),
  );
}
