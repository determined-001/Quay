#!/usr/bin/env node
/**
 * Enforces "no server-held key signs anything" in the two runtime trees that
 * could ever hold one: `apps/api/src` and `packages/offramp/src`.
 *
 * Why this exists (issue #207). Quay is non-custodial: every payment that moves
 * a seller's funds, and every anchor SEP-10 challenge, is signed by the
 * seller's own connected wallet. That was true by convention only. The dormant
 * SEP-24 `AnchorOffRamp` still built a withdrawal payment and called
 * `tx.sign(sellerKeypair)` when the anchor reached `pending_user_transfer_start`
 * — i.e. a server process that could send a seller's USDC — and `Sep10Client`
 * signed anchor challenges with a keypair it held. Both were unexported and
 * neither was wired up, but both were one `export` line and one container
 * branch away from being live, and both compiled and ran in the test suite.
 *
 * The fix for #207 deletes those paths. A header comment saying "do not re-add
 * this" is not a guard; this is. It fails CI if any file under the two trees
 * signs a transaction, materializes a secret seed, or builds a server-signed
 * SEP-10 challenge.
 *
 * Deliberately textual and deliberately dumb — an AST walk would be more
 * precise, but the job is a loud tripwire that costs nothing to read, not a
 * type system. Client-side helpers that legitimately hold a throwaway key (the
 * demo scripts under `apps/api/scripts/`, the SEP-10 reference harness under
 * `packages/offramp/test/`) are outside the scanned trees on purpose.
 *
 * Run via `pnpm check:no-server-signing`, wired into ci.yml next to
 * `docs:check-domain-boundary`. See docs/ARCHITECTURE.md ("Enforcement").
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, so the check behaves identically from CI and from a script. */
export const ROOT = resolve(HERE, "..");

/** The trees that must contain no server-side signing path. */
export const SCANNED_DIRS = ["apps/api/src", "packages/offramp/src"];

/**
 * What counts as "this process holds a key and signs with it".
 *
 * `readChallengeTx` is deliberately NOT matched: verifying a challenge is the
 * opposite of signing one, and it is how the seller's wallet-signed challenge
 * is checked (`anchor-session.ts`) and how Quay's own login challenge is
 * verified (`challenge.ts`).
 */
export const FORBIDDEN = [
  {
    id: ".sign(",
    re: /\.sign\s*\(/,
    why: "signs a transaction or payload with a key this process holds",
  },
  {
    id: "Keypair.fromSecret(",
    re: /Keypair\.fromSecret\s*\(/,
    why: "turns a server-held secret seed into a signer",
  },
  {
    id: "WebAuth.buildChallengeTx(",
    re: /WebAuth\.buildChallengeTx\s*\(/,
    why: "signs a SEP-10 challenge with a key this process holds",
  },
];

/**
 * Explicit, commented allowlist. Every entry is a signing path that is
 * legitimate for one specific reason, and each is spelled out here so adding a
 * new entry is visibly a security decision rather than a line in a diff:
 */
export const ALLOWLIST = new Map([
  [
    "apps/api/src/services/challenge.ts",
    "Quay's OWN SEP-10 login server. It signs the challenges its own sellers complete in their " +
      "wallet. The key is SERVER_SIGNING_SECRET and it holds no funds — it is this service's " +
      "identity to its users, not a seller's or an anchor's identity, so `WebAuth.buildChallengeTx` " +
      "here cannot move money or log anyone in anywhere else.",
  ],
  [
    "apps/api/src/services/seller-wallet.ts",
    "`keypairFromSecret()` / `Keypair.fromSecret()` used for config validation and the testnet " +
      "convenience seller. The server never signs with the result (see the module doc comment); " +
      "the seed is materialized so a malformed SERVER_SIGNING_SECRET/DEFAULT_SELLER_SECRET fails " +
      "at boot with a sentence instead of a stack trace inside the SDK's base32 decoder.",
  ],
]);

/** Every forbidden pattern in one file's source text, with 1-based line numbers. */
export function findForbidden(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) {
        hits.push({ line: i + 1, id: rule.id, why: rule.why, source: line.trim() });
      }
    }
  });
  return hits;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // A scanned tree that does not exist yet is not a violation.
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield full;
  }
}

/**
 * Scan the two runtime trees under `root`. Allowlisted paths are skipped
 * entirely — the allowlist is a review record, not a warning.
 */
export function scan(root = ROOT) {
  const violations = [];
  for (const relDir of SCANNED_DIRS) {
    for (const file of walk(join(root, relDir))) {
      const relPath = relative(root, file).split("\\").join("/");
      if (ALLOWLIST.has(relPath)) continue;
      for (const hit of findForbidden(readFileSync(file, "utf8"))) {
        violations.push({ file: relPath, ...hit });
      }
    }
  }
  violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return violations;
}

/** Allowlist entries whose file is gone. A stale entry is how an allowlist rots. */
export function staleAllowlist(root = ROOT) {
  const stale = [];
  for (const relPath of ALLOWLIST.keys()) {
    let exists = false;
    try {
      exists = statSync(join(root, relPath)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) stale.push(relPath);
  }
  return stale;
}

function main() {
  const stale = staleAllowlist();
  if (stale.length > 0) {
    console.error("[check-no-server-signing] allowlist entries whose file no longer exists:\n");
    for (const p of stale) console.error(`  ${p}`);
    console.error(
      "\nRemove the entry, or fix the path. An allowlist that points at deleted files " +
        "silently stops covering the file that replaced them.",
    );
    process.exit(1);
  }

  const violations = scan();
  if (violations.length > 0) {
    console.error("[check-no-server-signing] a server-held key signs in a runtime source tree:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.id} — ${v.why}`);
      console.error(`    ${v.source}\n`);
    }
    console.error(
      "Quay never signs for a seller. Move the signature to the seller's wallet: return a\n" +
        "`kind: \"transfer\"` instruction for the browser to sign (see packages/offramp/src/testanchor.ts)\n" +
        "or a SEP-10 challenge for the wallet to complete (see packages/offramp/src/anchor-session.ts).\n" +
        "If the key provably cannot move funds, add the file to ALLOWLIST with the reason.",
    );
    process.exit(1);
  }

  console.log(
    `[check-no-server-signing] clean — ${SCANNED_DIRS.join(", ")} contain no server-side signing path.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
