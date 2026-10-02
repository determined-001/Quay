#!/usr/bin/env node
// Mainnet preflight (docs/MAINNET.md Phase 5). Answers one question: would a
// real payment actually work, and would the money land somewhere you still
// control?
//
// The boot guards in apps/api/src/env.ts already refuse to start on a
// misconfigured pubnet deploy. They cannot check the things that live outside
// the process — whether the seller account exists, whether it carries a USDC
// trustline (without one the account cannot receive USDC at all, and the
// payment simply fails), whether the issuer is really Circle's, whether the
// database survives a redeploy. That is what this script is for.
//
// Two modes, both non-destructive and read-only:
//
//   node scripts/mainnet-preflight.mjs                 # static: check the env you export
//   node scripts/mainnet-preflight.mjs --api <url>     # also probe a live deploy
//
// Exit code is 0 only when every blocking check passes. Warnings never fail
// the run; they are the things that degrade a feature rather than lose money.

import { argv, env as processEnv, exit } from "node:process";

/**
 * Circle's USDC issuer on pubnet.
 *
 * Hardcoded on purpose. Minting an asset with the code "USDC" from any other
 * issuer is trivial and it is worth nothing, so the one value this check must
 * not read from the same configuration it is auditing is this one. Verify it
 * against Circle's own published address before the first real payment:
 * https://developers.circle.com/stablecoins/stellar-usdc
 */
export const CIRCLE_USDC_ISSUER_PUBNET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export const PUBNET_HORIZON = "https://horizon.stellar.org";

/** Min native balance we insist on: (2 + 1 trustline) * 0.5 base reserve = 1.5 XLM, plus fee headroom. */
const MIN_XLM_BLOCKING = 2.5;
const MIN_XLM_COMFORTABLE = 5;

const FETCH_TIMEOUT_MS = 15000;
// A cold Render instance can take the better part of a minute to answer its
// first request. A preflight that timed out on a spin-up would report the
// service as unreachable, which is a different (and much more alarming) claim
// than "slow to wake".
const DEPLOY_TIMEOUT_MS = 60000;

const HEX64 = /^[0-9a-f]{64}$/i;
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
const STELLAR_SECRET_SEED = /^S[A-Z2-7]{55}$/;

/** A check result. `level` decides whether a failure blocks the deploy. */
function pass(id, detail) {
  return { id, ok: true, level: "blocking", detail };
}
function fail(id, detail, level = "blocking") {
  return { id, ok: false, level, detail };
}
function warn(id, detail) {
  return fail(id, detail, "warning");
}
function skip(id, detail) {
  return { id, ok: true, level: "skipped", detail };
}

// ---------------------------------------------------------------------------
// Static checks — pure functions of the environment, no network.
// ---------------------------------------------------------------------------

export function checkNetwork(env) {
  if (env.STELLAR_NETWORK !== "public") {
    return fail(
      "network",
      `STELLAR_NETWORK is "${env.STELLAR_NETWORK ?? "unset"}", not "public". This preflight is only meaningful against a pubnet configuration.`,
    );
  }
  return pass("network", "STELLAR_NETWORK=public");
}

export function checkDatabase(env) {
  const url = env.DATABASE_URL;
  if (!url) {
    return fail("database", "DATABASE_URL is unset — apps/api falls back to file:./local.db, which is lost on every redeploy, taking the payment ledger with it.");
  }
  if (url.startsWith("file:")) {
    return fail("database", `DATABASE_URL is "${url}" — a local file. Every redeploy loses the payment ledger. Provision a real libsql/Turso database.`);
  }
  if (url.startsWith("libsql://") && !env.DATABASE_AUTH_TOKEN) {
    return fail("database", "DATABASE_URL points at a remote libsql database but DATABASE_AUTH_TOKEN is unset.");
  }
  return pass("database", `DATABASE_URL is remote (${url.split("://")[0]}://…) and authenticated`);
}

export function checkUsdcIssuer(env) {
  const issuer = env.USDC_ISSUER_PUBLIC;
  if (!issuer) {
    return fail("usdc-issuer", "USDC_ISSUER_PUBLIC is unset — the watcher cannot tell real USDC from an impostor asset.");
  }
  if (issuer !== CIRCLE_USDC_ISSUER_PUBNET) {
    return fail(
      "usdc-issuer",
      `USDC_ISSUER_PUBLIC is ${issuer}, which is NOT Circle's published pubnet issuer (${CIRCLE_USDC_ISSUER_PUBNET}). An asset coded "USDC" from another issuer is worth nothing.`,
    );
  }
  return pass("usdc-issuer", "USDC_ISSUER_PUBLIC matches Circle's pubnet issuer");
}

export function checkOfframp(env) {
  const mode = env.OFFRAMP ?? "mock";
  if (mode === "mock") {
    return fail("offramp", 'OFFRAMP=mock on pubnet: the mock anchor fakes settlement after 8s and pays out nothing. Use "none" to ship without a cash-out leg.');
  }
  if (mode === "testanchor") {
    return fail("offramp", "OFFRAMP=testanchor on pubnet: testanchor.stellar.org is the SDF sandbox and settles no real money.");
  }
  if (mode === "none") {
    return pass("offramp", "OFFRAMP=none — payments-only. No anchor to trust, no SEP-12 PII held, no seller secret on the server.");
  }
  if (mode === "anchor") {
    if (!env.ANCHOR_URL || !env.ANCHOR_HOME_DOMAIN) {
      return fail("offramp", "OFFRAMP=anchor requires both ANCHOR_URL and ANCHOR_HOME_DOMAIN. There is deliberately no default — a default would mean the sandbox.");
    }
    if (!env.ANCHOR_URL.startsWith("https://")) {
      return fail("offramp", `ANCHOR_URL must be https:// — SEP-10 tokens and SEP-12 KYC fields cross this connection. Got "${env.ANCHOR_URL}".`);
    }
    if (!env.KYC_ENCRYPTION_KEY) {
      return fail("offramp", "OFFRAMP=anchor collects seller SEP-12 PII; KYC_ENCRYPTION_KEY is unset, so it would be stored unencrypted.");
    }
    return pass("offramp", `OFFRAMP=anchor against ${env.ANCHOR_HOME_DOMAIN}`);
  }
  return fail("offramp", `OFFRAMP="${mode}" is not a recognised mode.`);
}

export function checkSellerWallet(env) {
  const wallet = env.DEFAULT_SELLER_WALLET;
  const secretRequired = (env.OFFRAMP ?? "mock") === "anchor";

  // Optional, and that is the point. Quay is multi-tenant: a seller signs in
  // with their own wallet over SEP-10 and every link they create is paid to
  // that address. This deployment does not need a wallet of its own, and
  // demanding one implied a custody relationship it does not have.
  if (!wallet) {
    if (secretRequired && !env.DEFAULT_SELLER_SECRET) {
      return fail("seller-wallet", "OFFRAMP=anchor needs DEFAULT_SELLER_SECRET to sign SEP-10 auth for the anchor.");
    }
    return warn(
      "seller-wallet",
      "No DEFAULT_SELLER_WALLET — sellers supply their own wallet at SEP-10 login, which is the multi-tenant path. /health will report usdcTrustline as not_configured; trustlines are still checked per seller on every link creation. Set one only if you want that health signal for your own wallet.",
    );
  }
  if (!STELLAR_PUBLIC_KEY.test(wallet)) {
    return fail("seller-wallet", `DEFAULT_SELLER_WALLET "${wallet}" is not a valid Stellar public key.`);
  }
  if (secretRequired && !env.DEFAULT_SELLER_SECRET) {
    return fail("seller-wallet", "OFFRAMP=anchor needs DEFAULT_SELLER_SECRET to sign SEP-10 auth for the anchor.");
  }
  if (!secretRequired && env.DEFAULT_SELLER_SECRET) {
    return warn(
      "seller-wallet",
      "DEFAULT_SELLER_SECRET is set but OFFRAMP is not \"anchor\". Under payments-only the server has no reason to hold a seller key — unset it and reduce the blast radius.",
    );
  }
  return pass("seller-wallet", `DEFAULT_SELLER_WALLET=${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
}

/** Secrets whose absence breaks something on every restart or leaves data unencrypted. */
export function checkSecrets(env) {
  const results = [];
  if (!env.SERVER_SIGNING_SECRET) {
    results.push(fail("secret:SERVER_SIGNING_SECRET", "Unset — a per-boot SEP-10 identity changes the advertised SIGNING_KEY on every restart, breaking every wallet that cached it."));
  } else if (!STELLAR_SECRET_SEED.test(env.SERVER_SIGNING_SECRET.trim())) {
    // Shape, not just presence. This is a Stellar secret seed, while three of
    // the four values `pnpm secrets:mainnet` prints are 64 hex characters —
    // pasting the wrong line is the failure this catches, and catching it here
    // beats catching it as a crashed deploy.
    const looksHex = /^[0-9a-f]{64}$/i.test(env.SERVER_SIGNING_SECRET.trim());
    results.push(
      fail(
        "secret:SERVER_SIGNING_SECRET",
        `Not a Stellar secret seed. Expected "S" plus 55 characters (56 total), got ${env.SERVER_SIGNING_SECRET.trim().length}` +
          (looksHex ? " that look like a 64-hex value — that is JWT_SECRET / METRICS_TOKEN / WEBHOOK_SECRET_ENCRYPTION_KEY's shape, not this one's." : "."),
      ),
    );
  } else if (env.SERVER_SIGNING_SECRET.trim() !== env.SERVER_SIGNING_SECRET) {
    results.push(warn("secret:SERVER_SIGNING_SECRET", "Valid seed, but with surrounding whitespace — it was probably pasted with a newline. The API refuses to boot on this."));
  } else {
    results.push(pass("secret:SERVER_SIGNING_SECRET", "set, valid Stellar seed"));
  }
  if (!env.JWT_SECRET) {
    results.push(fail("secret:JWT_SECRET", "Unset — every seller is logged out on each deploy."));
  } else if (!HEX64.test(env.JWT_SECRET)) {
    results.push(warn("secret:JWT_SECRET", "Set, but not 64 hex characters. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""));
  } else {
    results.push(pass("secret:JWT_SECRET", "set, 64 hex"));
  }
  for (const name of ["WEBHOOK_SECRET_ENCRYPTION_KEY", "METRICS_TOKEN"]) {
    if (!env[name]) {
      results.push(fail(`secret:${name}`, "Unset."));
    } else if (!HEX64.test(env[name])) {
      results.push(warn(`secret:${name}`, "Set, but not 64 hex characters."));
    } else {
      results.push(pass(`secret:${name}`, "set, 64 hex"));
    }
  }
  return results;
}

export function checkWebEnv(env) {
  const results = [];
  if (env.NEXT_PUBLIC_STELLAR_NETWORK !== "public") {
    results.push(
      fail(
        "web:network",
        `NEXT_PUBLIC_STELLAR_NETWORK is "${env.NEXT_PUBLIC_STELLAR_NETWORK ?? "unset"}". The browser signs with the passphrase this selects, so anything but "public" means every wallet signature is built for testnet and rejected — with no error naming the cause. Set it on the WEB deployment.`,
      ),
    );
  } else {
    results.push(pass("web:network", "NEXT_PUBLIC_STELLAR_NETWORK=public"));
  }
  const offramp = env.OFFRAMP ?? "mock";
  const webOfframp = env.NEXT_PUBLIC_OFFRAMP_MODE;
  if (webOfframp && webOfframp !== offramp) {
    results.push(fail("web:offramp", `NEXT_PUBLIC_OFFRAMP_MODE="${webOfframp}" disagrees with the API's OFFRAMP="${offramp}". The dashboard would offer a cash-out the API answers 501 to, or hide one that works.`));
  } else if (!webOfframp) {
    results.push(warn("web:offramp", `NEXT_PUBLIC_OFFRAMP_MODE is unset and defaults to "mock" in the dashboard, which labels cash-out as a simulation. Set it to "${offramp}" on the web deployment.`));
  } else {
    results.push(pass("web:offramp", `NEXT_PUBLIC_OFFRAMP_MODE=${webOfframp}`));
  }
  return results;
}

export function checkScaling(env) {
  if (env.REDIS_URL) {
    return pass("redis", "REDIS_URL set — rate limits and challenge nonces are shared");
  }
  // The API refuses to boot in this state, so catching it here turns a failed
  // deploy into a failed preflight — the same finding, ten minutes earlier.
  if (env.SINGLE_INSTANCE !== "true") {
    return fail(
      "redis",
      "REDIS_URL is unset and SINGLE_INSTANCE is not \"true\" — the API will refuse to boot. Rate-limit counters and SEP-10 challenge single-use claims are per-process without Redis, so N instances allow N× every limit and N redemptions of one signed challenge. Set REDIS_URL, or set SINGLE_INSTANCE=true if this deployment really does run one instance.",
    );
  }
  return warn(
    "redis",
    "Running on SINGLE_INSTANCE=true with no REDIS_URL. Correct for one instance, and only for one: scaling this service up without setting REDIS_URL silently multiplies every rate limit and makes one signed SEP-10 challenge redeemable once per instance.",
  );
}

/** Every static check, in report order. */
export function runStaticChecks(env) {
  return [
    checkNetwork(env),
    checkDatabase(env),
    checkUsdcIssuer(env),
    checkOfframp(env),
    checkSellerWallet(env),
    ...checkSecrets(env),
    ...checkWebEnv(env),
    checkScaling(env),
  ];
}

// ---------------------------------------------------------------------------
// Account checks — pure evaluation of a Horizon account payload.
// ---------------------------------------------------------------------------

/**
 * The check that catches the mistake docs/MAINNET.md warns about twice: an
 * account with XLM but no USDC trustline cannot receive USDC at all. The
 * payment does not arrive and sit unmatched — it fails outright.
 */
export function evaluateAccount(account, { issuer = CIRCLE_USDC_ISSUER_PUBNET } = {}) {
  const results = [];
  const balances = account?.balances ?? [];

  const native = balances.find((b) => b.asset_type === "native");
  const xlm = native ? Number(native.balance) : 0;
  if (!native) {
    results.push(fail("account:xlm", "Account holds no native balance."));
  } else if (xlm < MIN_XLM_BLOCKING) {
    results.push(fail("account:xlm", `${xlm} XLM is below the ${MIN_XLM_BLOCKING} XLM needed for the base reserve of an account with a trustline, plus transaction fees.`));
  } else if (xlm < MIN_XLM_COMFORTABLE) {
    results.push(warn("account:xlm", `${xlm} XLM covers the reserve but leaves little fee headroom (${MIN_XLM_COMFORTABLE} XLM suggested).`));
  } else {
    results.push(pass("account:xlm", `${xlm} XLM`));
  }

  const usdc = balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === issuer);
  if (!usdc) {
    const impostor = balances.find((b) => b.asset_code === "USDC");
    results.push(
      fail(
        "account:usdc-trustline",
        impostor
          ? `The account trusts a USDC from issuer ${impostor.asset_issuer}, NOT Circle's ${issuer}. Payments in the real asset would still fail, and the balance shown is a different token.`
          : `No USDC trustline for ${issuer}. Without it the account cannot receive USDC at all — the payment fails rather than arriving unmatched.`,
      ),
    );
  } else {
    const limit = Number(usdc.limit ?? 0);
    const balance = Number(usdc.balance ?? 0);
    if (limit > 0 && limit - balance <= 0) {
      results.push(fail("account:usdc-trustline", `USDC trustline is full (balance ${balance} of limit ${limit}) — further payments would be rejected.`));
    } else {
      results.push(pass("account:usdc-trustline", `USDC trustline present (balance ${balance}, limit ${limit || "max"})`));
    }
  }

  return results;
}

/** A live /health payload, evaluated. */
export function evaluateHealth(health) {
  const results = [];
  if (!health?.ok) {
    results.push(fail("live:health", `/health did not report ok: ${JSON.stringify(health)}`));
    return results;
  }
  if (health.network !== "public") {
    results.push(fail("live:health", `The deployed API reports network="${health.network}" — this is not the mainnet service.`));
  } else {
    results.push(pass("live:health", "deployed API reports network=public"));
  }
  if (health.usdcTrustline && health.usdcTrustline.ok === false) {
    // `not_configured` is the correct answer for a multi-tenant deployment, not
    // a fault: there is no operator wallet to check because the service owns no
    // wallet. Every seller's trustline is checked at link creation instead.
    // Treating this as a failure made a healthy mainnet deploy report FAILED.
    if (health.usdcTrustline.reason === "not_configured") {
      results.push(pass("live:trustline", "no operator wallet configured — trustlines are checked per seller at link creation"));
    } else {
      results.push(
        fail(
          "live:trustline",
          `The deployed API reports its configured wallet cannot receive USDC (${health.usdcTrustline.reason ?? "unknown reason"}). Add a USDC trustline to that account.`,
        ),
      );
    }
  }
  if (health.horizon?.degraded) {
    results.push(warn("live:horizon", "The deployed API reports Horizon as degraded."));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Network probes.
// ---------------------------------------------------------------------------

async function getJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    return { status: res.status, body: res.ok ? await res.json() : null };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAccount(wallet, { horizon = PUBNET_HORIZON, fetchJson = getJson } = {}) {
  if (!wallet || !STELLAR_PUBLIC_KEY.test(wallet)) {
    return [skip("account", "no valid DEFAULT_SELLER_WALLET to look up")];
  }
  try {
    const { status, body } = await fetchJson(`${horizon}/accounts/${wallet}`);
    if (status === 404) {
      return [fail("account", `${wallet} does not exist on pubnet. An unfunded account cannot receive anything — fund it with XLM first.`)];
    }
    if (!body) {
      return [warn("account", `Horizon returned ${status} for ${wallet}; could not verify funding or trustlines.`)];
    }
    return evaluateAccount(body);
  } catch (err) {
    return [warn("account", `Could not reach Horizon (${err.message}). Funding and trustline unverified.`)];
  }
}

export async function probeDeploy(apiUrl, { fetchJson = getJson } = {}) {
  if (!apiUrl) return [];
  const results = [];
  try {
    const { status, body } = await fetchJson(`${apiUrl.replace(/\/$/, "")}/health`, DEPLOY_TIMEOUT_MS);
    if (!body) {
      results.push(fail("live:health", `/health returned ${status}.`));
    } else {
      results.push(...evaluateHealth(body));
    }
  } catch (err) {
    results.push(fail("live:health", `Could not reach ${apiUrl}/health (${err.message}).`));
  }
  try {
    const { status, body } = await fetchJson(`${apiUrl.replace(/\/$/, "")}/ready`, DEPLOY_TIMEOUT_MS);
    if (body?.ok) {
      results.push(pass("live:ready", "/ready green — the settlement watcher is running"));
    } else {
      results.push(fail("live:ready", `/ready returned ${status} — the settlement watcher may not be running. Payments would arrive on the ledger and never be marked paid.`));
    }
  } catch (err) {
    results.push(fail("live:ready", `Could not reach ${apiUrl}/ready (${err.message}).`));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export function formatReport(results) {
  const lines = [];
  for (const r of results) {
    const mark = r.level === "skipped" ? "－" : r.ok ? "✓" : r.level === "warning" ? "!" : "✗";
    lines.push(`  ${mark} ${r.id.padEnd(34)} ${r.detail}`);
  }
  const blocking = results.filter((r) => !r.ok && r.level === "blocking");
  const warnings = results.filter((r) => !r.ok && r.level === "warning");
  lines.push("");
  lines.push(
    blocking.length === 0
      ? `PREFLIGHT PASSED — ${warnings.length} warning(s). Nothing here blocks a real payment.`
      : `PREFLIGHT FAILED — ${blocking.length} blocking, ${warnings.length} warning(s). Do not take a real payment until the blocking items are fixed.`,
  );
  return lines.join("\n");
}

export function exitCodeFor(results) {
  return results.some((r) => !r.ok && r.level === "blocking") ? 1 : 0;
}

async function main() {
  const apiIndex = argv.indexOf("--api");
  const apiUrl = apiIndex !== -1 ? argv[apiIndex + 1] : undefined;

  // Which configuration is this run actually looking at?
  //
  // The static checks read THIS process's environment. That is the right
  // source when you export the mainnet config locally and check it before
  // deploying. It is the wrong source — and actively misleading — when the
  // config lives in the Render dashboard, which is where render.mainnet.yaml
  // tells you to put every `sync: false` value. In that case the local shell
  // has none of it, every check fails, and a perfectly healthy deployment gets
  // reported as FAILED. A tool that cries wolf about a working system is worse
  // than no tool: it trains you to skim past the one line that matters.
  //
  // So: if a deployment was named and this shell has no mainnet config, the
  // deployment is the subject and the local environment is not evidence.
  const localConfigPresent = Boolean(processEnv.STELLAR_NETWORK || processEnv.DATABASE_URL);
  const results = [];

  if (!apiUrl || localConfigPresent) {
    results.push(...runStaticChecks(processEnv));
    results.push(...(await probeAccount(processEnv.DEFAULT_SELLER_WALLET)));
  } else {
    results.push(
      skip(
        "local-config",
        "No mainnet configuration in this shell, so the static checks are skipped — they would only describe your laptop. Values set in the Render dashboard cannot be read from here; the checks below probe the running service instead.",
      ),
    );
  }

  results.push(...(await probeDeploy(apiUrl)));

  console.log("Quay mainnet preflight");
  console.log("");
  if (apiUrl && !localConfigPresent) {
    console.log(`  Subject: the deployment at ${apiUrl}`);
    console.log("  To check configuration too, export it here and re-run (see docs/MAINNET.md).");
    console.log("");
  }
  console.log(formatReport(results));
  exit(exitCodeFor(results));
}

if (import.meta.url === `file://${argv[1]}`) {
  await main();
}
