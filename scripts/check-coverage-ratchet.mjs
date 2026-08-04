#!/usr/bin/env node
// Enforces the "ratchet-only" rule from issue 8.1: coverage-thresholds.json's
// numbers may only go up, never down. Diffs the working tree's copy against
// the same file on the base branch (default origin/main) and fails on any
// decrease - including a threshold flipping from a real number to null
// (disabling enforcement), which is a regression too.
//
// Usage: node scripts/check-coverage-ratchet.mjs [baseRef]
// Wired into CI via `pnpm docs:check-coverage-ratchet` on pull_request events.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(here, "..", "coverage-thresholds.json");
const baseRef = process.argv[2] ?? "origin/main";

function loadCurrent() {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadBase(ref) {
  try {
    const raw = execFileSync("git", ["show", `${ref}:coverage-thresholds.json`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw);
  } catch {
    return null; // file/ref doesn't exist yet (first introduction, or no base fetched) - nothing to ratchet against
  }
}

function flatten(obj, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    if (key === "_comment") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value; // number or null
    }
  }
  return out;
}

const current = loadCurrent();
const base = loadBase(baseRef);

if (base === null) {
  console.log(
    `[check-coverage-ratchet] no coverage-thresholds.json found at ${baseRef} - nothing to compare against, skipping.`,
  );
  process.exit(0);
}

const currentFlat = flatten(current);
const baseFlat = flatten(base);

const regressions = [];
for (const [path, baseValue] of Object.entries(baseFlat)) {
  if (baseValue === null) continue; // wasn't enforced before - nothing to ratchet
  const currentValue = currentFlat[path];
  if (currentValue === null || currentValue === undefined) {
    regressions.push(`${path}: was ${baseValue}, now unset/null (enforcement removed)`);
  } else if (currentValue < baseValue) {
    regressions.push(`${path}: was ${baseValue}, now ${currentValue} (decreased)`);
  }
}

if (regressions.length > 0) {
  console.error(
    `[check-coverage-ratchet] coverage-thresholds.json lowered a threshold vs. ${baseRef} - ` +
      "thresholds are ratchet-only (issue 8.1): they may rise, never fall.\n",
  );
  for (const r of regressions) console.error(`  ${r}`);
  console.error(
    "\nIf a threshold genuinely needs to drop (e.g. new, currently-untested code was added on " +
      "purpose), that's a maintainer decision, not something to fix by editing this file back down.",
  );
  process.exit(1);
}

console.log(`[check-coverage-ratchet] clean - no threshold decreased vs. ${baseRef}.`);
