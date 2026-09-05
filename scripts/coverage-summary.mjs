#!/usr/bin/env node
/**
 * Renders every package's coverage-summary.json as one markdown table, and
 * writes it to $GITHUB_STEP_SUMMARY (stdout when run locally).
 *
 * Why a step summary rather than a PR comment: contributor PRs come from forks,
 * and a fork's GITHUB_TOKEN is read-only, so a comment step would silently fail
 * on exactly the PRs a reviewer most wants the numbers for. The summary renders
 * for everyone. The gate itself is vitest's own threshold check — this script
 * only reports, and never decides.
 */
import { readFileSync, existsSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = [
  "packages/core",
  "packages/stellar",
  "packages/offramp",
  "packages/soroban",
  "packages/widget",
  "apps/api",
];

const METRICS = ["lines", "statements", "functions", "branches"];

function thresholdsFor(dir) {
  // The thresholds live in the package's vitest config; read them back rather
  // than duplicating the numbers here, so this table cannot drift from the gate.
  const cfg = join(dir, "vitest.config.ts");
  if (!existsSync(cfg)) return null;
  const m = readFileSync(cfg, "utf8").match(/coverage\(\{([^}]*)\}\)/);
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (k && v) out[k] = Number(v);
  }
  return out;
}

const rows = [];
for (const dir of PACKAGES) {
  const file = join(dir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) {
    rows.push({ dir, missing: true });
    continue;
  }
  const total = JSON.parse(readFileSync(file, "utf8")).total;
  const th = thresholdsFor(dir) ?? {};
  rows.push({
    dir,
    pct: Object.fromEntries(METRICS.map((k) => [k, total[k]?.pct])),
    th,
  });
}

const lines = [];
lines.push("## Coverage");
lines.push("");
lines.push("| Package | " + METRICS.map((m) => m[0].toUpperCase() + m.slice(1)).join(" | ") + " |");
lines.push("| --- | " + METRICS.map(() => "---").join(" | ") + " |");
for (const r of rows) {
  if (r.missing) {
    lines.push(`| \`${r.dir}\` | _no report_ | | | |`);
    continue;
  }
  const cells = METRICS.map((m) => {
    const pct = r.pct[m];
    if (typeof pct !== "number") return "—";
    const floor = r.th[m];
    const mark = typeof floor === "number" && pct < floor ? " ❌" : "";
    const headroom = typeof floor === "number" ? ` <sub>(floor ${floor})</sub>` : "";
    return `${pct.toFixed(1)}%${headroom}${mark}`;
  });
  lines.push(`| \`${r.dir}\` | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("Floors are a ratchet — raise them with the coverage, never lower them to go green.");

const text = lines.join("\n") + "\n";
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
else process.stdout.write(text);
