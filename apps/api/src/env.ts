import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal dependency-free .env loader. Walks up from this file and the cwd,
// loading the first .env it finds without overwriting already-set vars.
function loadEnvFiles(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(here, "../../../.env"),
    resolve(here, "../../../../.env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const text = readFileSync(path, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

loadEnvFiles();

/**
 * Numeric env var with a default.
 *
 * `Number(process.env.X ?? "6000")` — the pattern this replaces — is wrong in
 * two ways that only bite in production. An empty value (a variable declared
 * but left blank in a hosting dashboard, which is easy to do and looks unset)
 * satisfies `??`, so `Number("")` yields 0: TRUST_PROXY_HOPS silently stopped
 * trusting the proxy, which collapses every client into one rate-limit bucket
 * keyed on the edge IP. A typo yields NaN, and `setInterval(NaN)` is not a slow
 * poll — it is a tight loop against Horizon.
 *
 * Both are rejected here, loudly, at boot.
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return n;
}

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

export type StellarNetwork = "testnet" | "public";

const network = (process.env.STELLAR_NETWORK ?? "testnet") as StellarNetwork;
if (network !== "testnet" && network !== "public") {
  throw new Error(`STELLAR_NETWORK must be "testnet" or "public", got "${network}"`);
}

const watchMode = (process.env.WATCH_MODE ?? "poll") as "poll" | "stream";
if (watchMode !== "poll" && watchMode !== "stream") {
  throw new Error(`WATCH_MODE must be "poll" or "stream", got "${watchMode}"`);
}

// "memo" (default): correlation via MEMO_TEXT. "muxed": SEP-23 M-address, no
// memo needed — survives wallets that drop/mangle memos. Some older wallets
// refuse M... destinations, so this stays opt-in until measured in practice.
const correlation = (process.env.CORRELATION ?? "memo") as "memo" | "muxed";
if (correlation !== "memo" && correlation !== "muxed") {
  throw new Error(`CORRELATION must be "memo" or "muxed", got "${correlation}"`);
}

// Off-ramp adapter:
//   "mock"       — default, offline-safe simulation. Settles itself. No anchor.
//   "testanchor" — real SEP-10/12/38/6 flow against https://testanchor.stellar.org.
//   "anchor"     — the same SEP-6 adapter pointed at an operator-supplied
//                  production anchor via ANCHOR_URL / ANCHOR_HOME_DOMAIN.
//   "none"       — no cash-out leg at all. Payments settle directly to the
//                  seller's wallet and the seller moves their own funds.
// See packages/offramp/src/testanchor.ts — one adapter, three configurations —
// and packages/offramp/src/disabled.ts for "none".
export type OffRampKind = "mock" | "testanchor" | "anchor" | "none";
const OFFRAMP_KINDS: readonly OffRampKind[] = ["mock", "testanchor", "anchor", "none"];
const offramp = (process.env.OFFRAMP ?? "mock") as OffRampKind;
if (!OFFRAMP_KINDS.includes(offramp)) {
  throw new Error(
    `OFFRAMP must be one of ${OFFRAMP_KINDS.map((k) => `"${k}"`).join(", ")}, got "${offramp}"`,
  );
}

// ---------------------------------------------------------------------------
// Mainnet guardrails.
// ---------------------------------------------------------------------------
// Every check below is a thing that is merely awkward on testnet and is a
// money incident on pubnet. They run at module load so a misconfigured
// deployment cannot boot green and start taking real payments — a process that
// refuses to start is loud; one that silently settles into a sandbox anchor is
// not. Nothing here is reachable when STELLAR_NETWORK=testnet.
if (network === "public") {
  // "anchor" and "none" are the two valid pubnet settings. "none" is in fact
  // the safest configuration this service has: with no cash-out leg there is
  // no anchor to trust, no SEP-12 PII to hold, and no seller secret key on the
  // server at all — see packages/offramp/src/disabled.ts.
  if (offramp === "mock") {
    throw new Error(
      "OFFRAMP=mock on public network: the mock anchor fakes settlement after 8s " +
        "and pays out nothing. Sellers would see completed cash-outs against real " +
        'funds that never left. Set OFFRAMP=anchor with a production anchor.',
    );
  }
  if (offramp === "testanchor") {
    throw new Error(
      "OFFRAMP=testanchor on public network: https://testanchor.stellar.org is the " +
        "SDF testnet sandbox and does not settle real money. Set OFFRAMP=anchor and " +
        "point ANCHOR_URL / ANCHOR_HOME_DOMAIN at a production anchor.",
    );
  }
}

// A production anchor is operator-supplied — there is no sane default, and
// defaulting would silently mean "the testnet sandbox".
const anchorUrl =
  offramp === "anchor" ? req("ANCHOR_URL") : process.env.ANCHOR_URL || undefined;
const anchorHomeDomain =
  offramp === "anchor" ? req("ANCHOR_HOME_DOMAIN") : process.env.ANCHOR_HOME_DOMAIN || undefined;
if (anchorUrl && !/^https:\/\//.test(anchorUrl) && network === "public") {
  throw new Error(`ANCHOR_URL must be https:// on public network, got "${anchorUrl}"`);
}


/**
 * The domain this service identifies as in SEP-10 challenges and in
 * `/.well-known/stellar.toml`.
 *
 * Order matters:
 *
 *  1. `HOME_DOMAIN`, when the deployment sits behind a domain of its own — a
 *     custom domain or a proxy. Then the host the platform knows about and the
 *     host wallets fetch the TOML from are genuinely different, and only the
 *     operator can say which is which.
 *  2. The hosting platform's own answer. Render injects
 *     `RENDER_EXTERNAL_HOSTNAME`; there is no reason to make someone retype a
 *     value the platform already knows, and every reason not to — an unset
 *     variable silently produced `WEB_AUTH_ENDPOINT="https://localhost:8787/auth"`
 *     on a live deploy, which breaks wallet login while everything reports
 *     healthy.
 *  3. localhost, for local development.
 */
function resolveHomeDomain(): string {
  const explicit = process.env.HOME_DOMAIN?.trim();
  if (explicit) return explicit;

  // Render sets this on every service. Other platforms expose an equivalent;
  // add them here rather than pushing the problem back onto the operator.
  const platform = process.env.RENDER_EXTERNAL_HOSTNAME?.trim();
  if (platform) return platform;

  return `localhost:${num("API_PORT", 8787)}`;
}

export const env = {
  network,
  // JSON-line log verbosity. trace|debug|info|warn|error|fatal, default "info".
  logLevel: process.env.LOG_LEVEL || "info",
  horizonUrl: process.env.HORIZON_URL || undefined,
  // Optional standby Horizon endpoint. The watcher switches to it after
  // several consecutive failures on the primary, and back on recovery.
  horizonUrlFallback: process.env.HORIZON_URL_FALLBACK || undefined,
  // Consecutive Horizon failures (after retries) before /health reports
  // degraded and (if HORIZON_URL_FALLBACK is set) the watcher switches to it.
  horizonDegradedThreshold: num("HORIZON_DEGRADED_THRESHOLD", 3),
  usdcIssuer:
    network === "public"
      ? req("USDC_ISSUER_PUBLIC")
      : req("USDC_ISSUER_TESTNET", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
  databaseUrl: process.env.DATABASE_URL || "file:./local.db",
  // Turso auth token. Unused for local file: URLs.
  databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  apiPort: num("API_PORT", 8787),
  pollMs: num("WATCH_POLL_MS", 6000),
  // Per-account Horizon page size and the max pages drained per account per
  // tick before the rest waits for the next poll (issue 2.2). Raising
  // WATCH_MAX_PAGES_PER_TICK trades tick latency for backlog-drain speed;
  // if it's routinely maxed out, that's the signal to move to a streaming
  // watcher (issue 2.1), not to keep raising this.
  watchPageLimit: num("WATCH_PAGE_LIMIT", 200),
  watchMaxPagesPerTick: num("WATCH_MAX_PAGES_PER_TICK", 10),
  // "poll" (default, restart-safe MVP behavior) or "stream" (Horizon SSE,
  // opt-in until proven). See packages/stellar/src/streaming-horizon-watcher.ts.
  watchMode,
  correlation,
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Fixed-window rate limit per client IP. Set RATE_LIMIT_MAX=0 to disable.
  rateLimitWindowMs: num("RATE_LIMIT_WINDOW_MS", 60000),
  rateLimitMax: num("RATE_LIMIT_MAX", 120),
  // Tighter buckets for expensive routes (link creation, cash-out).
  rateLimitStrictWindowMs: num("RATE_LIMIT_STRICT_WINDOW_MS", 60000),
  rateLimitStrictMax: num("RATE_LIMIT_STRICT_MAX", 20),
  // Number of trusted reverse-proxy hops in front of this instance. Determines
  // which x-forwarded-for entry (from the right) is treated as the real client IP.
  // Default 1 in production (Render's own edge proxy), 0 locally where nothing
  // sits in front of the API and the header (if present at all) is untrusted.
  trustProxyHops: num("TRUST_PROXY_HOPS", network === "public" ? 1 : 0),
  // When set, rate-limit counters are shared across instances via Redis instead
  // of an in-process Map.
  redisUrl: process.env.REDIS_URL || undefined,
  // Seller wallet that receives funds. If unset on testnet, the app generates a
  // throwaway keypair on first boot and prints it. Required on public network.
  defaultSellerWallet: process.env.DEFAULT_SELLER_WALLET || undefined,
  defaultSellerName: process.env.DEFAULT_SELLER_NAME || "Demo Seller",
  offramp,
  // Base URL and SEP-10 home domain of the anchor. Required for OFFRAMP=anchor;
  // for OFFRAMP=testanchor these stay undefined and the adapter's own testnet
  // defaults apply.
  anchorUrl,
  anchorHomeDomain,
  // Preferred SEP-6 withdrawal type (e.g. "bank_account"). Unset means "read
  // /sep6/info and use the only enabled type, or refuse if there are several".
  offrampType: process.env.OFFRAMP_TYPE || undefined,
  // Required only when a real anchor is configured and DEFAULT_SELLER_WALLET is set (SEP-10
  // needs the seller's secret key to sign the auth challenge). Never persisted.
  defaultSellerSecret: process.env.DEFAULT_SELLER_SECRET || undefined,
  // Bearer token required to read GET /metrics. Auto-generates an ephemeral one
  // (printed once at boot) if unset — the endpoint is always gated.
  metricsToken: process.env.METRICS_TOKEN || undefined,
  // Domain we identify as in SEP-10 challenges + stellar.toml. Should match where
  // this API is actually reachable in production.
  homeDomain: resolveHomeDomain(),
  webAuthDomain: process.env.WEB_AUTH_DOMAIN || resolveHomeDomain(),
  // Secret key for the identity that SIGNS SEP-10 challenges (our server, not any
  // seller). Auto-generates a throwaway testnet keypair if unset. Required on
  // public network — a login server's signing key must be stable across restarts.
  serverSigningSecret: process.env.SERVER_SIGNING_SECRET || undefined,
  // Symmetric secret for session JWTs minted after a SEP-10 login. Auto-generates
  // an ephemeral one on testnet if unset (sessions won't survive a restart);
  // required on public network.
  jwtSecret: process.env.JWT_SECRET || undefined,
  // Whether the session cookie gets the `Secure` attribute (only sent over
  // HTTPS). Defaults on; set COOKIE_SECURE=false for plain-http local dev,
  // where a Secure cookie would otherwise silently never be sent at all.
  cookieSecure: (process.env.COOKIE_SECURE ?? "true") !== "false",
  // Watcher concurrency and fairness settings
  watcherConcurrency: num("WATCHER_CONCURRENCY", 10),
  watcherMaxAccountsPerTick: num("WATCHER_MAX_ACCOUNTS_PER_TICK", 50),
  watcherCircuitBreakerThreshold: num("WATCHER_CIRCUIT_BREAKER_THRESHOLD", 5),
  watcherCircuitBreakerCooldownMs: num("WATCHER_CIRCUIT_BREAKER_COOLDOWN_MS", 60000),
  watcherIdleBackoffTicks: num("WATCHER_IDLE_BACKOFF_TICKS", 10),
  watcherAggressivePollTicks: num("WATCHER_AGGRESSIVE_POLL_TICKS", 5),
  shutdownTimeoutMs: num("SHUTDOWN_TIMEOUT_MS", 5000),
  // Deployed `quay-attest` contract id (see contracts/README.md). Unset means
  // settlements are never attested on-chain and receipts simply say so —
  // attestation is additive to the SEP settlement path, never a prerequisite.
  attestationContractId: process.env.ATTESTATION_CONTRACT_ID || undefined,
  // Soroban RPC used to write and read attestations. Defaults to the public
  // testnet endpoint; must be set explicitly for pubnet.
  sorobanRpcUrl:
    process.env.SOROBAN_RPC_URL ||
    (network === "public" ? undefined : "https://soroban-testnet.stellar.org"),
  // How often the sweeper retries links that settled but were never attested.
  attestationSweepMs: num("ATTESTATION_SWEEP_MS", 60000),
  // AES-256-GCM key (32 bytes, hex) for seller KYC field values at rest.
  // Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Required only when a real anchor is configured. "mock" never stores PII,
  // and "none" has no KYC lifecycle to store PII for.
  kycEncryptionKey:
    offramp === "testanchor" || offramp === "anchor" ? req("KYC_ENCRYPTION_KEY") : undefined,
} as const;
