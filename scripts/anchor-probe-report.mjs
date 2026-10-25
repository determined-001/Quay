#!/usr/bin/env node
// Turns the nightly anchor probe's vitest output into the text of the
// auto-filed failure issue (.github/workflows/anchor-probe.yml), so the issue
// names the flow that broke instead of always blaming "SEP-1 -> ... -> SEP-6".
//
//   node scripts/anchor-probe-report.mjs <out.md> <vitest-output.txt>...
//
// Reads vitest's verbose reporter output, where every failed test is repeated
// in the closing summary as `FAIL  <file> > <describe> > <test>`.

import { readFileSync, writeFileSync } from "node:fs";
import { argv } from "node:process";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Failed tests as `{ file, path[] }`, de-duplicated, in first-seen order. */
export function parseFailures(output) {
  const seen = new Set();
  const failures = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = raw.replace(ANSI, "").match(/^\s*FAIL\s+(\S+?\.test\.ts)\s+>\s+(.+?)\s*$/);
    if (!m) continue;
    const key = `${m[1]} > ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ file: m[1], path: m[2].split(" > ").map((p) => p.trim()) });
  }
  return failures;
}

/** Which probe flow a failing test belongs to. */
export function flowOf(failure) {
  const full = failure.path.join(" > ");
  if (/full seller-signed cash-out/i.test(full)) {
    const stage = full.match(/stage \d+\/\d+ ([a-z]+)/i)?.[1];
    return { id: "full-cashout", label: `Full seller-signed cash-out${stage ? `, stage "${stage}"` : ""}` };
  }
  if (/SEP-24/i.test(full) || /sep-?24/i.test(failure.file)) {
    return { id: "sep24", label: "SEP-24 interactive withdrawal (AnchorOffRamp)" };
  }
  if (/testanchor\.test\.ts$/.test(failure.file)) {
    return { id: "sep6", label: "SEP-1 → SEP-10 → SEP-38 → SEP-6 (TestAnchorOffRamp)" };
  }
  return { id: "other", label: "Other offramp test (not a live-anchor suite)" };
}

/** Markdown for the "What broke" section of the issue. */
export function renderWhatBroke(failures) {
  if (failures.length === 0) {
    return "The probe exited non-zero but no individual failing test was found in its output. The job probably failed before or outside the tests (install, a crash, a timeout). Check the run log.";
  }
  const flows = [...new Map(failures.map((f) => [flowOf(f).label, flowOf(f)])).keys()];
  const lines = ["Failing flow(s):", "", ...flows.map((l) => `- ${l}`), "", "Failing tests:", ""];
  for (const f of failures) lines.push(`- \`${f.file}\` › ${f.path.join(" › ")}`);
  return lines.join("\n");
}

function main() {
  const [, , outFile, ...inputs] = argv;
  if (!outFile || inputs.length === 0) {
    console.error("usage: anchor-probe-report.mjs <out.md> <vitest-output.txt>...");
    process.exitCode = 2;
    return;
  }
  const text = inputs
    .map((p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return ""; // a step that was skipped writes no output file
      }
    })
    .join("\n");
  writeFileSync(outFile, renderWhatBroke(parseFailures(text)) + "\n", "utf8");
}

if (import.meta.url === `file://${argv[1]}`) main();
