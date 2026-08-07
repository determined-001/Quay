#!/usr/bin/env node
/**
 * Bulk-creates the Quay product backlog on GitHub from ISSUES.md.
 *
 * Acts as the repo owner `determined-001` against `determined-001/Quay`:
 * the script refuses to run under any other GitHub identity unless you
 * explicitly override it, so issues can never land on the wrong account.
 *
 * Prerequisites
 *   1. GitHub CLI installed:  https://cli.github.com
 *   2. Authenticated as determined-001:  gh auth login
 *      (if you hold several accounts:    gh auth switch --user determined-001)
 *
 * Usage
 *   node .github/create-issues.js                  # create everything missing
 *   node .github/create-issues.js --dry-run        # print the plan, write nothing
 *   node .github/create-issues.js --only 3         # just major 3 (offramp)
 *   node .github/create-issues.js --only 3.6,1.1   # specific issues
 *   node .github/create-issues.js --limit 5        # first 5 pending issues
 *   node .github/create-issues.js --no-milestones  # skip milestone creation
 *   node .github/create-issues.js --repo owner/name --actor login   # override
 *
 * The script is idempotent: it reads the repo's existing issue titles first and
 * skips anything already there, so a partial run can simply be re-run.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_ACTOR = "determined-001";
const DEFAULT_REPO = "determined-001/Quay";
const SOURCE_FILE = path.join(__dirname, "..", "ISSUES.md");

// Major issue number -> area label. Majors are permanent; see ISSUES.md.
const AREA_BY_MAJOR = {
  1: "area:core",
  2: "area:stellar",
  3: "area:offramp",
  4: "area:api",
  5: "area:web",
  6: "area:auth",
  7: "area:distribution",
  8: "area:ops",
  9: "area:soroban",
};

const LABEL_DEFS = [
  ["Stellar Wave", "7B3FE4", "Drips Wave Program - opt an issue in by applying this label"],
  ["complexity:trivial", "C2E0C6", "100 points"],
  ["complexity:medium", "FBCA04", "150 points"],
  ["complexity:high", "D93F0B", "200 points"],
  ["area:core", "0E8A16", "packages/core - domain, ports, status machine, matcher"],
  ["area:stellar", "1D76DB", "packages/stellar - SEP-7 rail, Horizon watcher"],
  ["area:offramp", "5319E7", "packages/offramp - anchors, SEP-1/6/10/12/24/38"],
  ["area:api", "006B75", "apps/api - routes, worker, persistence, delivery"],
  ["area:web", "B60205", "apps/web - dashboard, checkout, widget"],
  ["area:auth", "E99695", "wallet-native auth + multi-tenancy"],
  ["area:distribution", "0075CA", "npm packages, docs, grant framing, demo assets"],
  ["area:ops", "5B5B5B", "CI, Docker, metrics, backups, uptime"],
  ["area:soroban", "2C3E50", "contracts/ - Soroban contracts and on-chain attestation"],
  ["type:bug", "D73A4A", ""],
  ["type:feature", "A2EEEF", ""],
  ["type:docs", "0075CA", ""],
  ["type:test", "BFE5BF", ""],
  ["type:refactor", "FEF2C0", ""],
  ["type:perf", "F9D0C4", ""],
  ["type:security", "EE0701", ""],
  ["type:dx", "C5DEF5", ""],
  ["type:ops", "D4C5F9", ""],
  ["good-first-issue", "7057FF", "Self-contained, well-scoped, safe for newcomers"],
  ["help-wanted", "008672", "Open for anyone, not newcomer-gated"],
];

// Issues deliberately kept newcomer-friendly (see ISSUES.md 7.7).
const GOOD_FIRST_ISSUES = new Set(["1.6", "5.5", "7.4", "7.6", "8.5", "8.7"]);

const MILESTONES = [
  ["M1 - Off-ramp depth", "Can a seller actually get local currency, from a real anchor, reliably?"],
  ["M2 - Multi-tenant platform", "Can someone who is not us run this without trusting us?"],
  ["M3 - Settlement correctness", "Does every on-chain payment land in the right state, exactly once?"],
  ["M4 - Merchant surface", "Can a merchant integrate in an afternoon?"],
  ["M5 - Distribution & grant", "Can a stranger install it, and can a committee fund it?"],
  ["M6 - Ops & rigor", "Do we know when it breaks, and can we prove it works?"],
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    force: false,
    milestones: true,
    limit: Infinity,
    only: null,
    repo: DEFAULT_REPO,
    actor: DEFAULT_ACTOR,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--no-milestones") opts.milestones = false;
    else if (arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "--only") opts.only = String(argv[++i]).split(",").map((s) => s.trim());
    else if (arg === "--repo") opts.repo = argv[++i];
    else if (arg === "--actor") opts.actor = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}  (try --help)`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(opts.limit) && opts.limit !== Infinity) {
    console.error("--limit expects a number");
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

function gh(args, { quiet = false } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error("\ngh (GitHub CLI) is not installed or not on PATH.\nInstall it: https://cli.github.com\n");
      process.exit(1);
    }
    if (!quiet) console.error(`  spawn error: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    if (!quiet) console.error(`  exit ${result.status}: ${(result.stderr || "").trim()}`);
    return null;
  }
  return (result.stdout || "").trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Identity gate — this is the "use determined-001" part
// ---------------------------------------------------------------------------

function ensureActor(opts) {
  console.log("Checking GitHub CLI authentication…");
  let login = gh(["api", "user", "--jq", ".login"], { quiet: true });

  if (login && login !== opts.actor) {
    console.log(`  currently authenticated as ${login}; switching to ${opts.actor}…`);
    const switched = gh(["auth", "switch", "--user", opts.actor], { quiet: true });
    if (switched !== null) login = gh(["api", "user", "--jq", ".login"], { quiet: true });
  }

  if (!login) {
    console.error(`\nNot authenticated. Run:\n  gh auth login\n  gh auth switch --user ${opts.actor}\n`);
    process.exit(1);
  }

  if (login !== opts.actor) {
    console.error(
      `\nAuthenticated as "${login}" but this script targets ${opts.repo} as "${opts.actor}".\n` +
        `Fix it:  gh auth switch --user ${opts.actor}\n` +
        `Or override deliberately:  --actor ${login} --force\n`,
    );
    if (!opts.force) process.exit(1);
    console.error(`  --force given; continuing as ${login}.\n`);
  }

  console.log(`  authenticated as: ${login}`);

  const repoCheck = gh(["repo", "view", opts.repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { quiet: true });
  if (!repoCheck) {
    console.error(`\nCannot reach ${opts.repo} as ${login}. Check the name and your access.\n`);
    process.exit(1);
  }
  console.log(`  target repository: ${repoCheck}`);
  return login;
}

// ---------------------------------------------------------------------------
// Labels & milestones
// ---------------------------------------------------------------------------

function createLabels(opts) {
  console.log("\n── Labels ─────────────────────────────────────────────────");
  for (const [name, color, desc] of LABEL_DEFS) {
    process.stdout.write(`  ${name.padEnd(22)} `);
    if (opts.dryRun) {
      console.log("· dry-run");
      continue;
    }
    const args = ["label", "create", name, "--repo", opts.repo, "--color", color, "--force"];
    if (desc) args.push("--description", desc);
    console.log(gh(args, { quiet: true }) !== null ? "✓" : "✗ (continuing)");
  }
}

/** @returns {Map<string, number>} milestone title -> number */
function createMilestones(opts) {
  const map = new Map();
  if (!opts.milestones) return map;

  console.log("\n── Milestones ─────────────────────────────────────────────");
  const [owner, repo] = opts.repo.split("/");

  const existingRaw = gh(["api", `repos/${owner}/${repo}/milestones?state=all&per_page=100`], { quiet: true });
  if (existingRaw) {
    try {
      for (const m of JSON.parse(existingRaw)) map.set(m.title, m.number);
    } catch {
      /* fall through to creation */
    }
  }

  for (const [title, description] of MILESTONES) {
    process.stdout.write(`  ${title.padEnd(30)} `);
    if (map.has(title)) {
      console.log(`· exists (#${map.get(title)})`);
      continue;
    }
    if (opts.dryRun) {
      console.log("· dry-run");
      continue;
    }
    const out = gh(
      ["api", "--method", "POST", `repos/${owner}/${repo}/milestones`, "-f", `title=${title}`, "-f", `description=${description}`, "--jq", ".number"],
      { quiet: true },
    );
    if (out) {
      map.set(title, Number(out));
      console.log(`✓ #${out}`);
    } else {
      console.log("✗ (continuing without it)");
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// ISSUES.md parser
// ---------------------------------------------------------------------------

const HEADING = /^### (\d+\.\d+) - (.+)$/;

function areaLabel(num) {
  const major = Number.parseInt(num.split(".")[0], 10);
  const label = AREA_BY_MAJOR[major];
  if (!label) console.error(`  ⚠ issue ${num}: major ${major} has no area label`);
  return label || "";
}

function parseComplexity(line) {
  const labels = [];
  if (/trivial/i.test(line)) labels.push("complexity:trivial");
  else if (/medium/i.test(line)) labels.push("complexity:medium");
  else if (/high/i.test(line)) labels.push("complexity:high");
  for (const tok of line.match(/`([^`]+)`/g) || []) labels.push(tok.replace(/`/g, ""));
  return labels;
}

function parseIssues(content) {
  const lines = content.split("\n");
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(HEADING);
    if (!heading) continue;

    const num = heading[1];
    const title = `${num} - ${heading[2].replace(/`/g, "").trim()}`;

    const body = [];
    let inFence = false;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) inFence = !inFence;
      if (!inFence) {
        if (HEADING.test(line) || /^## /.test(line)) {
          i--; // let the outer loop re-read this line
          break;
        }
        if (line.trim() === "---") break;
      }
      body.push(line);
    }

    const text = body.join("\n").trim();
    const labels = ["Stellar Wave", areaLabel(num)].filter(Boolean);

    const complexity = text.match(/\*\*Complexity:\*\*\s+(.+)/);
    if (complexity) labels.push(...parseComplexity(complexity[1]));
    if (GOOD_FIRST_ISSUES.has(num)) labels.push("good-first-issue");

    const milestone = text.match(/\*\*Milestone:\*\*\s+(.+)/);

    issues.push({
      num,
      title,
      body: `${text}\n\n---\n_Tracked in [\`ISSUES.md\`](../blob/main/ISSUES.md) — issue ${num}._`,
      labels: [...new Set(labels)],
      milestone: milestone ? milestone[1].trim() : null,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Existing issues (idempotency)
// ---------------------------------------------------------------------------

function existingTitles(opts) {
  const raw = gh(
    ["issue", "list", "--repo", opts.repo, "--state", "all", "--limit", "1000", "--json", "title", "--jq", ".[].title"],
    { quiet: true },
  );
  if (raw === null) {
    console.error("  ⚠ could not list existing issues — duplicates are possible");
    return new Set();
  }
  return new Set(raw.split("\n").filter(Boolean).map((t) => t.trim()));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(SOURCE_FILE)) {
    console.error(`\nCannot find ${SOURCE_FILE}\n`);
    process.exit(1);
  }

  const all = parseIssues(fs.readFileSync(SOURCE_FILE, "utf8"));
  if (all.length === 0) {
    console.error("\nParsed 0 issues from ISSUES.md — check the heading format (### N.N - Title).\n");
    process.exit(1);
  }

  console.log(`\nQuay issue sync — ${all.length} issues defined in ISSUES.md`);
  if (opts.dryRun) console.log("DRY RUN — nothing will be written.\n");

  ensureActor(opts);
  createLabels(opts);
  const milestones = createMilestones(opts);

  const seen = opts.dryRun ? new Set() : existingTitles(opts);

  let selected = all;
  if (opts.only) {
    selected = all.filter((issue) => opts.only.some((f) => issue.num === f || issue.num.startsWith(`${f}.`)));
  }

  const pending = selected.filter((issue) => !seen.has(issue.title));
  const skipped = selected.length - pending.length;
  const batch = pending.slice(0, opts.limit === Infinity ? undefined : opts.limit);

  console.log(`\n── Creating ${batch.length} issues ${skipped ? `(${skipped} already exist) ` : ""}──────────────`);

  let created = 0;
  let failed = 0;

  for (let idx = 0; idx < batch.length; idx++) {
    const issue = batch[idx];
    const prefix = `[${String(idx + 1).padStart(3)}/${batch.length}]`;
    process.stdout.write(`${prefix} ${issue.title.slice(0, 62).padEnd(62)} `);

    if (opts.dryRun) {
      console.log(`· ${issue.labels.join(",")}${issue.milestone ? ` · ${issue.milestone}` : ""}`);
      continue;
    }

    const tmpFile = path.join(os.tmpdir(), `quay-issue-${issue.num}-${process.pid}.md`);
    fs.writeFileSync(tmpFile, issue.body, "utf8");

    const args = [
      "issue", "create",
      "--repo", opts.repo,
      "--title", issue.title,
      "--body-file", tmpFile,
      "--label", issue.labels.join(","),
    ];
    if (issue.milestone && milestones.has(issue.milestone)) {
      args.push("--milestone", issue.milestone);
    }

    const url = gh(args);

    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best effort */
    }

    if (url) {
      console.log(`✓  ${url}`);
      created++;
    } else {
      console.log("✗  (see error above)");
      failed++;
    }

    sleep(400); // be polite to the API
  }

  console.log("\n── Summary ────────────────────────────────────────────────");
  console.log(`  Defined  : ${all.length}`);
  console.log(`  Selected : ${selected.length}`);
  console.log(`  Skipped  : ${skipped} (already on the repo)`);
  console.log(`  Created  : ${created}`);
  console.log(`  Failed   : ${failed}`);
  if (!opts.dryRun && failed === 0 && created > 0) console.log("\nAll issues created. ✓");
  if (failed > 0) process.exitCode = 1;
}

main();
