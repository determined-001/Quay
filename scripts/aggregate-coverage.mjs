#!/usr/bin/env node
// Aggregates each package's `coverage/coverage-summary.json` (produced by
// vitest's "json-summary" coverage reporter) into one workspace-wide summary,
// and prints a markdown table (used for the CI artifact, the step summary,
// and the sticky PR comment) - issue 8.1's "aggregate across the workspace"
// and "comment the delta on PRs" requirements.
//
// Usage: node scripts/aggregate-coverage.mjs
// Must run after `pnpm test` (which writes each package's coverage/ dir).

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const thresholds = JSON.parse(readFileSync(join(root, "coverage-thresholds.json"), "utf8"));
const PACKAGES = Object.keys(thresholds).filter((k) => k !== "_comment");
const METRICS = ["lines", "statements", "functions", "branches"];

function loadSummary(pkg) {
  const summaryPath = join(root, pkg, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) return null;
  const data = JSON.parse(readFileSync(summaryPath, "utf8"));
  return data.total ?? null;
}

function pct(covered, total) {
  return total === 0 ? 100 : Math.round((covered / total) * 10000) / 100;
}

const rows = [];
const workspaceTotals = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));

for (const pkg of PACKAGES) {
  const total = loadSummary(pkg);
  const pkgThresholds = thresholds[pkg];

  if (!total) {
    rows.push({ pkg, missing: true });
    continue;
  }

  const metrics = {};
  for (const m of METRICS) {
    const { covered, total: metricTotal } = total[m] ?? { covered: 0, total: 0 };
    metrics[m] = { pct: pct(covered, metricTotal), covered, total: metricTotal };
    workspaceTotals[m].covered += covered;
    workspaceTotals[m].total += metricTotal;
  }

  rows.push({ pkg, metrics, threshold: pkgThresholds });
}

const workspaceMetrics = Object.fromEntries(
  METRICS.map((m) => [m, pct(workspaceTotals[m].covered, workspaceTotals[m].total)]),
);

function statusFor(row) {
  if (row.missing) return "no report";
  if (!row.threshold) return "not gated";
  const failing = METRICS.some((m) => row.metrics[m].pct < row.threshold[m]);
  return failing ? "BELOW THRESHOLD" : "ok";
}

function formatMetric(row, m) {
  if (row.missing) return "-";
  const value = `${row.metrics[m].pct}%`;
  const min = row.threshold ? row.threshold[m] : undefined;
  return min !== undefined ? `${value} (min ${min}%)` : value;
}

const lines = [];
lines.push("### Coverage report (issue 8.1)");
lines.push("");
lines.push("| Package | Lines | Statements | Functions | Branches | Status |");
lines.push("|---|---|---|---|---|---|");
for (const row of rows) {
  const cells = row.missing
    ? ["-", "-", "-", "-"]
    : METRICS.map((m) => formatMetric(row, m));
  lines.push(`| \`${row.pkg}\` | ${cells.join(" | ")} | ${statusFor(row)} |`);
}
lines.push(
  `| **workspace (aggregate)** | ${METRICS.map((m) => `${workspaceMetrics[m]}%`).join(" | ")} | - |`,
);
lines.push("");
lines.push(
  "_Aggregate is a simple covered/total roll-up across every package's own report - it isn't " +
    "itself gated (each package's own threshold is); it's here so the workspace-wide trend is " +
    "visible in one place._",
);

const markdown = lines.join("\n");

console.log(markdown);

const outDir = join(root, "coverage");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "workspace-summary.json"), JSON.stringify({ rows, workspaceMetrics }, null, 2));
writeFileSync(join(outDir, "workspace-summary.md"), markdown);

const anyFailing = rows.some((r) => statusFor(r) === "BELOW THRESHOLD");
if (anyFailing) {
  console.error(
    "\n[aggregate-coverage] at least one package is below its own threshold - " +
      "`pnpm test` for that package should already have failed the build; this is a summary, not a second gate.",
  );
}
