#!/usr/bin/env node
// Uptime + synthetic check, multi-environment (issue 8.8). Run standalone
// (`pnpm sweep`) or on a schedule (.github/workflows/uptime.yml), which also
// persists history to docs/uptime-state.json and regenerates docs/STATUS.md +
// the README badges.
//
// No external monitoring service required: this is the whole check.
//
// Environments: testnet is always checked, using the same env vars and target
// ids (`api` / `web` / `synthetic`) this script has always used — existing
// history and badge files keep working with no migration. Mainnet is checked
// only once UPTIME_MAINNET_API_URL is actually set (a repo Actions variable,
// see docs/RUNBOOK.md): unlike testnet there is no default of any kind, on
// purpose — render.mainnet.yaml's own guidance is that a default here would
// silently mean "the testnet sandbox", and a mainnet outage that goes
// unreported because the checker quietly monitored the wrong service is worse
// than one that's honestly unconfigured. Mainnet's targets are prefixed
// (`mainnet-api` / `mainnet-web` / `mainnet-synthetic`) so they get their own
// history series and never collide with testnet's.
//
// `mainnet-synthetic` is a READ-ONLY authenticated probe (issue 8.27 / #526):
// `GET /links?limit=1` with a key scoped to `links:read` only, so every run
// proves the production API accepts a key and reads from the real database
// without writing a row. The old write check (POST + cancel) stays available
// behind UPTIME_MAINNET_SYNTHETIC_CHECK, off by default on mainnet, and takes
// the `mainnet-synthetic-write` id when enabled so the two never share a
// history series. A probe whose key is not configured is reported as
// "not configured" and records nothing: a missing secret is not an outage.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const statePath = resolve(root, "docs/uptime-state.json");
const statusPath = resolve(root, "docs/STATUS.md");

const HISTORY_DAYS = 90;
const FETCH_TIMEOUT_MS = 15000;
const FAILURE_THRESHOLD = 2;

function envUrl(vars, name) {
  const v = vars[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * The environments this run checks. `apiUrl: null` means "not configured" —
 * filtered out below rather than checked against a guessed URL.
 */
export function buildEnvironments(vars = process.env) {
  return [
    {
      id: "testnet",
      label: "Testnet",
      // Back-compat: UPTIME_API_URL / UPTIME_WEB_URL are the original,
      // unprefixed names this script has always read; always defaults to the
      // public testnet deploy so `pnpm sweep` works with zero setup.
      apiUrl: envUrl(vars, "UPTIME_TESTNET_API_URL") ?? envUrl(vars, "UPTIME_API_URL") ?? "https://quay-api.onrender.com",
      webUrl: envUrl(vars, "UPTIME_TESTNET_WEB_URL") ?? envUrl(vars, "UPTIME_WEB_URL") ?? "https://quay-web.vercel.app",
      // Dedicated least-privilege key (links:read + links:write) for the
      // synthetic write check — POST /links has required auth since 6.x.
      apiKey: envUrl(vars, "UPTIME_API_KEY"),
      // The read-only probe is a mainnet protection (issue 8.27): testnet's
      // synthetic write check is its authenticated probe, and testnet keeps
      // the `synthetic` id it has always had.
      readProbe: false,
      syntheticLink: true,
      prefixIds: false,
    },
    {
      id: "mainnet",
      label: "Mainnet",
      apiUrl: envUrl(vars, "UPTIME_MAINNET_API_URL"),
      webUrl: envUrl(vars, "UPTIME_MAINNET_WEB_URL"),
      // Its own key, never testnet's — a testnet key cannot read mainnet's
      // links, and sharing one would defeat the least-privilege point. This is
      // the READ-ONLY key: scope `links:read` alone (issue 8.27).
      apiKey: envUrl(vars, "UPTIME_MAINNET_API_KEY"),
      // Always on once mainnet is configured: `GET /links?limit=1` writes
      // nothing, so there is no production side effect to opt into. It proves
      // the write-free half of the authenticated path (a key is accepted and
      // reads real data) that a missing secret used to hide.
      readProbe: true,
      // Off unless explicitly opted into: this writes a throwaway row into the
      // REAL production database on every successful run. Issue 8.9 gave the
      // check a scoped key and cleanup, so it is now safe to enable — but it
      // stays opt-in because "safe to run" is not the same as "should run
      // against production without the operator deciding to".
      syntheticLink: envUrl(vars, "UPTIME_MAINNET_SYNTHETIC_CHECK") === "1",
      prefixIds: true,
    },
  ];
}

/** Environments that actually have an API URL configured — the rest are skipped, not guessed. */
export function activeEnvironments(environments) {
  return environments.filter((env) => env.apiUrl);
}

/** Per-environment targets: API (always), web (if configured), synthetic-link (if enabled). */
export function buildTargets(environments) {
  const targets = [];
  for (const env of activeEnvironments(environments)) {
    const prefix = env.prefixIds ? `${env.id}-` : "";
    targets.push({
      id: `${prefix}api`,
      kind: "API",
      label: `${env.label} — API`,
      env,
      check: () => checkGet(`${env.apiUrl}/health`),
    });
    if (env.webUrl) {
      targets.push({
        id: `${prefix}web`,
        kind: "Web dashboard",
        label: `${env.label} — Web dashboard`,
        env,
        check: () => checkGet(env.webUrl),
      });
    }
    if (env.readProbe) {
      targets.push({
        id: `${prefix}synthetic`,
        kind: "Authenticated read (synthetic)",
        label: `${env.label} — Authenticated read (synthetic)`,
        env,
        check: () => checkAuthProbe(env.apiUrl, env.apiKey),
      });
    }
    if (env.syntheticLink) {
      targets.push({
        // Testnet keeps `synthetic` for its write check (back-compat). On
        // mainnet the read probe above owns that id, so the opt-in write check
        // gets its own — two checks sharing an id would merge their histories.
        id: `${prefix}synthetic${env.readProbe ? "-write" : ""}`,
        kind: "Create-link (synthetic)",
        label: `${env.label} — Create-link (synthetic)`,
        env,
        check: () => checkSyntheticLink(env.apiUrl, env.apiKey),
      });
    }
  }
  return targets;
}

async function checkGet(url) {
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
}

/**
 * A check that cannot run because its credential is missing. Distinct from a
 * failure on purpose: an unset secret is a configuration gap, not an outage,
 * so it must not be recorded as downtime or drag the uptime figure down
 * (issue 8.27). `main()` logs it and leaves the target's history untouched.
 */
export class NotConfiguredError extends Error {}

/**
 * Read-only authenticated probe (issue 8.27 / #526): proves mainnet's API
 * accepts a seller key and reads from the real database, without writing a
 * single row.
 *
 * `GET /links` accepts any authenticated seller (session or scoped key), so a
 * key with `links:read` alone is enough — the least privilege that answers the
 * only question worth asking in production: is the authenticated read path
 * alive? `limit=1` keeps the response tiny; the API may ignore it.
 *
 * A key that IS configured but rejected (401) is a real failure — revoked,
 * wrong scope, or the testnet key pasted into the mainnet secret.
 */
export async function checkAuthProbe(apiUrl, apiKey, fetchImpl = fetchWithTimeout) {
  if (!apiKey) {
    throw new NotConfiguredError(
      `GET ${apiUrl}/links needs an API key and none is configured. ` +
        "Create a least-privilege key (scope links:read only) in the dashboard and store it as the " +
        "UPTIME_MAINNET_API_KEY repository secret.",
    );
  }

  const url = `${apiUrl}/links?limit=1`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` },
  });

  if (res.status === 401) {
    throw new Error(
      `GET ${url} -> HTTP 401 (expected 200): the configured key was rejected — ` +
        "it may be revoked, lack links:read, or belong to another environment",
    );
  }
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} (expected 200)`);
}

/**
 * Synthetic create-link check: proves the authenticated public write path
 * works end to end (issue 8.9).
 *
 * `POST /links` has required a seller session or a scoped API key since 6.x,
 * so this check 401'd on every run for reasons that had nothing to do with
 * availability — a permanent false negative sitting next to two real checks.
 * It now sends a dedicated least-privilege key (`links:read` + `links:write`).
 *
 * The created link is cancelled immediately afterwards so synthetic rows stop
 * accumulating. Cleanup failure is logged, not fatal: the write path — the
 * thing being measured — already succeeded by that point, and failing the
 * probe over cleanup would report an outage that isn't one.
 */
export async function checkSyntheticLink(apiUrl, apiKey, fetchImpl = fetchWithTimeout) {
  // No key at all is a missing secret, not a broken write path. Report it as
  // "not configured" instead of POSTing an unauthenticated request just to
  // watch it 401 and record an outage (issue 8.27).
  if (!apiKey) {
    throw new NotConfiguredError(
      `POST ${apiUrl}/links needs an API key and none is configured. ` +
        "Add a least-privilege API key (links:read + links:write) as the UPTIME_API_KEY repo secret " +
        "(UPTIME_MAINNET_API_KEY for mainnet).",
    );
  }

  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };

  const createRes = await fetchImpl(`${apiUrl}/links`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "uptime-check", amount: "0.0000001", assetCode: "XLM" }),
  });

  if (createRes.status !== 201) {
    throw new Error(`POST ${apiUrl}/links -> HTTP ${createRes.status} (expected 201)`);
  }

  try {
    const body = await createRes.json();
    const linkId = body?.link?.id;
    if (!linkId) return;
    const cancelRes = await fetchImpl(`${apiUrl}/links/${linkId}/cancel`, {
      method: "POST",
      headers,
    });
    if (!cancelRes.ok) {
      console.warn(`[uptime] could not cancel synthetic link ${linkId} (HTTP ${cancelRes.status})`);
    }
  } catch (err) {
    console.warn(`[uptime] synthetic link cleanup failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { targets: {} };
  }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "2026-07-27"
}

function emptyTargetState() {
  return { consecutiveFailures: 0, lastStatus: null, lastCheckedAt: null, today: null, history: [] };
}

/** Mutates `state.targets[id]` with this run's result; returns { justFailed, justRecovered }. */
export function recordResult(state, id, ok, message) {
  const t = (state.targets[id] ??= emptyTargetState());
  const day = todayUTC();

  if (!t.today || t.today.date !== day) {
    if (t.today) {
      t.history.push({ date: t.today.date, up: t.today.up, down: t.today.down });
      if (t.history.length > HISTORY_DAYS) t.history = t.history.slice(-HISTORY_DAYS);
    }
    t.today = { date: day, up: 0, down: 0 };
  }
  if (ok) t.today.up += 1;
  else t.today.down += 1;

  const wasFailing = t.consecutiveFailures >= FAILURE_THRESHOLD;
  t.consecutiveFailures = ok ? 0 : t.consecutiveFailures + 1;
  const isFailing = t.consecutiveFailures >= FAILURE_THRESHOLD;

  t.lastStatus = ok ? "up" : "down";
  t.lastCheckedAt = new Date().toISOString();
  t.lastError = ok ? null : message;

  return { justFailed: !wasFailing && isFailing, justRecovered: wasFailing && ok };
}

export function uptimePct(history, today) {
  const days = today ? [...history, { up: today.up, down: today.down }] : history;
  const totals = days.reduce((acc, d) => ({ up: acc.up + d.up, down: acc.down + d.down }), { up: 0, down: 0 });
  const total = totals.up + totals.down;
  return total === 0 ? 100 : (100 * totals.up) / total;
}

function renderBadge(targetState, id) {
  const pct = uptimePct(targetState.history, targetState.today);
  const color =
    targetState.consecutiveFailures >= FAILURE_THRESHOLD ? "red" : pct >= 99.5 ? "brightgreen" : pct >= 95 ? "yellow" : "orange";
  return {
    schemaVersion: 1,
    label: id,
    message: `${pct.toFixed(2)}% (90d)`,
    color,
  };
}

/** Grouped by environment, so a green testnet section can never stand in for a missing mainnet one. */
export function renderStatusMd(state, environments) {
  const targets = buildTargets(environments);
  const lines = [
    "# Status",
    "",
    // Issue 8.9: regeneration stopped when the schedule was disabled, so this
    // page kept showing an old green. A visible timestamp makes a stale page
    // read as stale rather than as healthy.
    `> **Last regenerated:** ${new Date().toISOString()}`,
    "",
    "Generated by `.github/workflows/uptime.yml` (every 5 minutes) — do not edit by hand.",
    "",
  ];
  for (const env of activeEnvironments(environments)) {
    const envTargets = targets.filter((t) => t.env === env);
    if (!envTargets.some((t) => state.targets[t.id])) continue; // never checked yet — nothing to report
    lines.push(`## ${env.label}`);
    lines.push("");
    for (const target of envTargets) {
      const t = state.targets[target.id];
      if (!t) continue;
      const pct = uptimePct(t.history, t.today);
      lines.push(`### ${target.kind}`);
      lines.push("");
      lines.push(`- Status: **${t.lastStatus === "up" ? "🟢 up" : "🔴 down"}** (last checked ${t.lastCheckedAt})`);
      lines.push(`- Uptime (last ${HISTORY_DAYS} days): **${pct.toFixed(2)}%**`);
      if (t.lastError) lines.push(`- Last error: \`${t.lastError}\``);
      lines.push("");
      lines.push("| Date | Up | Down |");
      lines.push("| --- | --- | --- |");
      const rows = [...t.history, t.today].filter(Boolean).slice(-HISTORY_DAYS);
      for (const row of rows.slice().reverse()) {
        lines.push(`| ${row.date} | ${row.up} | ${row.down} |`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Runs one target's check and classifies the result. Exported so the three
 * outcomes (up / down / not configured) are tested against the same code the
 * CLI runs, rather than a copy that could drift.
 */
export async function evaluateTarget(target) {
  try {
    await target.check();
    return { outcome: "up", message: null };
  } catch (err) {
    if (err instanceof NotConfiguredError) {
      return { outcome: "not-configured", message: err.message };
    }
    return { outcome: "down", message: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const environments = buildEnvironments(process.env);
  const targets = buildTargets(environments);
  const state = await loadState();
  const events = [];

  for (const target of targets) {
    const { outcome, message } = await evaluateTarget(target);
    if (outcome === "not-configured") {
      // Leave the tree alone: no up, no down, no bad badge. The last real
      // result stands until the operator supplies the key.
      console.log(`[uptime] ${target.label}: NOT CONFIGURED — ${message}`);
      continue;
    }
    const ok = outcome === "up";
    const { justFailed, justRecovered } = recordResult(state, target.id, ok, message);
    console.log(`[uptime] ${target.label}: ${ok ? "OK" : `FAIL — ${message}`}`);
    if (justFailed) events.push({ type: "failed", target });
    if (justRecovered) events.push({ type: "recovered", target });
  }

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
  await writeFile(statusPath, renderStatusMd(state, environments) + "\n");

  for (const target of targets) {
    const targetState = state.targets[target.id];
    // Never checked (e.g. "not configured"): no data to put on a badge, and a
    // 100% badge for a probe that never ran would be a lie.
    if (!targetState) continue;
    const badgePath = resolve(root, `docs/uptime-badge-${target.id}.json`);
    await writeFile(badgePath, JSON.stringify(renderBadge(targetState, target.id), null, 2) + "\n");
  }

  if (events.length > 0) {
    console.log(
      "EVENTS_JSON=" +
        JSON.stringify(events.map((e) => ({ type: e.type, target: e.target.id, label: e.target.label }))),
    );
  }

  const anyDown = targets.some((t) => state.targets[t.id]?.consecutiveFailures >= FAILURE_THRESHOLD);
  if (anyDown && process.env.UPTIME_STRICT_EXIT === "1") process.exitCode = 1;
}

function isCliInvocation() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isCliInvocation()) {
  main().catch((err) => {
    console.error("[uptime] fatal:", err);
    process.exitCode = 1;
  });
}
