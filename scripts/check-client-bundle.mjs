#!/usr/bin/env node
/**
 * Fails if a package we have deliberately excluded from the browser turns up in
 * the built client bundle.
 *
 * Why this exists: Stellar Wallets Kit declares every wallet integration as a
 * hard dependency, including Trezor and a HOT-wallet SDK that drags in Solana.
 * Those trees carry real HIGH/CRITICAL advisories (`protobufjs`, mainly). We
 * import six browser-extension wallet modules by subpath and none of those, so
 * the code is installed but never shipped or executed — which is the entire
 * basis on which those advisories are allowlisted in
 * `.github/audit-allowlist.txt`.
 *
 * That justification is only true while it stays true. Someone adding
 * `modules/trezor` to `apps/web/lib/wallet.ts` would quietly turn seven
 * accepted-because-unreachable advisories into seven reachable ones, and the
 * allowlist would still say they were fine. This turns that from a comment into
 * a check.
 *
 * Run after `pnpm --filter @checkout/web build`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = join(ROOT, "apps", "web", ".next", "static");

/** Markers that should never appear in browser-delivered JavaScript. */
const FORBIDDEN = [
  { marker: "protobufjs", why: "Trezor tree; carries the CRITICAL/HIGH advisories we allowlisted as unreachable" },
  { marker: "@trezor", why: "hardware-wallet module is not imported by lib/wallet.ts" },
  { marker: "@hot-wallet", why: "pulls in @solana/web3.js and its advisories" },
  { marker: "@solana/web3.js", why: "not a Stellar dependency; arrives only via the HOT wallet SDK" },
];

if (!existsSync(STATIC_DIR)) {
  console.error(
    `[check-client-bundle] ${STATIC_DIR} does not exist.\n` +
      "Build the web app first: pnpm --filter @checkout/web build",
  );
  process.exit(1);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".js")) yield full;
  }
}

const hits = [];
let scanned = 0;

for (const file of walk(STATIC_DIR)) {
  scanned++;
  const src = readFileSync(file, "utf8");
  for (const { marker, why } of FORBIDDEN) {
    if (src.includes(marker)) {
      hits.push({ file: file.replace(`${ROOT}/`, ""), marker, why });
    }
  }
}

if (hits.length > 0) {
  console.error("[check-client-bundle] excluded packages reached the browser bundle:\n");
  for (const h of hits) {
    console.error(`  ${h.marker}\n    in: ${h.file}\n    why it must not be here: ${h.why}\n`);
  }
  console.error(
    "Either stop importing the wallet module that pulled this in (see\n" +
      "apps/web/lib/wallet.ts), or re-review the corresponding entries in\n" +
      ".github/audit-allowlist.txt — they were accepted on the grounds that this\n" +
      "code never reaches a browser, and that is no longer true.",
  );
  process.exit(1);
}

console.log(`[check-client-bundle] clean — ${scanned} client chunks, none contain excluded packages.`);
