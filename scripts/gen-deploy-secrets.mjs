#!/usr/bin/env node
/**
 * Generate the deploy secrets `render.yaml` declares as `sync: false`, and
 * write them into the local .env.
 *
 *   node scripts/gen-deploy-secrets.mjs            # fill in what's missing
 *   node scripts/gen-deploy-secrets.mjs --print    # also show the values, to paste into Render
 *   node scripts/gen-deploy-secrets.mjs --force    # regenerate even if already set (see warning)
 *
 * Three rules this follows, because getting them wrong is expensive:
 *
 *  1. An existing value is never replaced without --force. Regenerating
 *     KYC_ENCRYPTION_KEY or WEBHOOK_SECRET_ENCRYPTION_KEY makes every value
 *     already encrypted under the old key permanently unreadable — that is data
 *     loss, not a rotation. See docs/RUNBOOK.md's key-rotation section.
 *  2. The .env is backed up before it is touched.
 *  3. Secrets are not printed unless you ask. A value echoed into a terminal
 *     lands in scrollback and shell history.
 */
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const PRINT = process.argv.includes("--print");
const FORCE = process.argv.includes("--force");

// pnpm keeps dependencies isolated per package, so the SDK is resolved through
// apps/api rather than assumed to be hoisted to the root.
const require = createRequire(import.meta.url);
const { Keypair } = await import(
  pathToFileURL(require.resolve("@stellar/stellar-sdk", { paths: [join(ROOT, "apps", "api")] })).href
);

const hex32 = () => randomBytes(32).toString("hex");

/** Parsed as names → values, preserving the original file for rewriting. */
const original = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
const existing = new Map();
for (const line of original.split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) existing.set(m[1], m[2].trim());
}

const network = (existing.get("STELLAR_NETWORK") || "testnet").replace(/["']/g, "");

const results = [];
const added = new Map();

function ensure(name, generate, note) {
  const current = existing.get(name);
  if (current && current !== "" && !FORCE) {
    results.push({ name, status: "kept", note: "already set — not touched" });
    return null;
  }
  const value = generate();
  added.set(name, value);
  results.push({ name, status: current ? "REGENERATED" : "generated", note });
  return value;
}

ensure("KYC_ENCRYPTION_KEY", hex32, "AES-256-GCM for seller SEP-12 PII at rest");
ensure("WEBHOOK_SECRET_ENCRYPTION_KEY", hex32, "AES-256-GCM for webhook signing secrets at rest");
ensure("JWT_SECRET", hex32, "signs session JWTs issued after SEP-10 login");

let signerPublic = null;
const signerSecret = ensure(
  "SERVER_SIGNING_SECRET",
  () => {
    const kp = Keypair.random();
    signerPublic = kp.publicKey();
    return kp.secret();
  },
  "SEP-10 signing identity AND the on-chain attester",
);

// Write ---------------------------------------------------------------------

if (added.size > 0) {
  if (existsSync(ENV_PATH)) {
    const backup = `${ENV_PATH}.backup`;
    copyFileSync(ENV_PATH, backup);
    chmodSync(backup, 0o600);
    console.log(`backed up .env -> ${backup}`);
  }

  let out = original;
  for (const [name, value] of added) {
    const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
    if (re.test(out)) out = out.replace(re, `${name}=${value}`);
    else out = `${out.replace(/\n*$/, "")}\n${name}=${value}\n`;
  }
  if (!/# ---- Deploy secrets/.test(out) && added.size > 0) {
    out = out.replace(
      new RegExp(`\\n(${[...added.keys()][0]}=)`),
      "\n\n# ---- Deploy secrets (render.yaml sync:false) ----\n$1",
    );
  }
  writeFileSync(ENV_PATH, out);
  chmodSync(ENV_PATH, 0o600);
}

// Fund the attester ----------------------------------------------------------

if (signerSecret && network !== "public") {
  process.stdout.write(`funding ${signerPublic} on ${network}… `);
  try {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${signerPublic}`);
    console.log(res.ok ? "funded" : `friendbot returned ${res.status} — fund it manually`);
  } catch (err) {
    console.log(`failed (${err.message}) — fund it manually before deploying`);
  }
}

// Report ---------------------------------------------------------------------

console.log("");
for (const r of results) {
  const mark = r.status === "kept" ? "·" : r.status === "REGENERATED" ? "!" : "+";
  console.log(`  ${mark} ${r.name.padEnd(30)} ${r.status.padEnd(13)} ${r.note ?? ""}`);
}

if (signerPublic) {
  console.log(`\n  SERVER_SIGNING_SECRET public key: ${signerPublic}`);
  console.log("  This account pays attestation invocation fees. It must stay funded,");
  console.log("  or settlements succeed while receipts silently carry no attestation.");
}

if (added.size === 0) {
  console.log("\nNothing to do — every secret was already set. Use --force to regenerate.");
} else if (!PRINT) {
  console.log("\nValues written to .env (chmod 600) and not printed.");
  console.log("Re-run with --print to display them for pasting into the Render dashboard.");
} else {
  console.log("\nPaste these into Render → Environment. Do not commit or paste them anywhere else:\n");
  for (const [name, value] of added) console.log(`${name}=${value}`);
}

if (FORCE && results.some((r) => r.status === "REGENERATED")) {
  console.log(
    "\nWARNING: --force replaced an existing key. Anything already encrypted under the\n" +
      "previous KYC_ENCRYPTION_KEY or WEBHOOK_SECRET_ENCRYPTION_KEY can no longer be\n" +
      "decrypted. If that database has real rows, restore .env.backup now.",
  );
}
