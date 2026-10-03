import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  FORBIDDEN,
  ROOT,
  SCANNED_DIRS,
  findForbidden,
  scan,
  staleAllowlist,
} from "./check-no-server-signing.mjs";

// ---------------------------------------------------------------------------
// Issue #207. `check-no-server-signing.mjs` is the CI guard that keeps the
// dormant SEP-24 `AnchorOffRamp` (`tx.sign(sellerKeypair)`) and `Sep10Client`
// (`tx.sign(this.keypair)`) from coming back. A guard nobody tests is a guard
// that quietly stops matching — these use the same fixture style as the other
// `scripts/*.test.ts` suites.
// ---------------------------------------------------------------------------

describe("findForbidden", () => {
  it("flags a transaction signed with a held keypair, with its line number", () => {
    const hits = findForbidden("const amount = 1;\n  tx.sign(this.sellerKeypair);\n");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      line: 2,
      id: ".sign(",
      source: "tx.sign(this.sellerKeypair);",
    });
  });

  it("flags a secret seed turned into a signer, and a server-signed challenge", () => {
    expect(findForbidden("return Keypair.fromSecret(trimmed);")[0].id).toBe("Keypair.fromSecret(");
    expect(findForbidden('WebAuth.buildChallengeTx(kp, account, "a.example", 300, net, host);')[0].id).toBe(
      "WebAuth.buildChallengeTx(",
    );
  });

  it("flags a bare keypair signing a payload, not just a Transaction", () => {
    // Keypair.sign() can sign arbitrary bytes — still a key this process holds.
    expect(findForbidden("const sig = this.keypair.sign(payload);")[0].id).toBe(".sign(");
  });

  it("does not flag verifying a challenge or anything that merely looks like a call", () => {
    // readChallengeTx is the opposite of signing — it is how the seller's
    // wallet-signed challenge is checked (`anchor-session.ts`) and how Quay's
    // own login challenge is verified (`challenge.ts`). It must stay allowed.
    expect(findForbidden("WebAuth.readChallengeTx(xdr, key, net, domain, host);")).toEqual([]);
    expect(findForbidden("const signature = response.signature;")).toEqual([]);
    expect(findForbidden('console.log("design( the withdrawal");')).toEqual([]);
  });

  it("keeps a rule id for each pattern so failures name the construct", () => {
    expect(FORBIDDEN.map((r) => r.id)).toEqual([".sign(", "Keypair.fromSecret(", "WebAuth.buildChallengeTx("]);
  });
});

describe("scan", () => {
  it("walks both runtime trees and reports file and line", () => {
    const root = mkdtempSync(join(tmpdir(), "no-server-signing-"));
    try {
      mkdirSync(join(root, "apps/api/src/routes"), { recursive: true });
      writeFileSync(join(root, "apps/api/src/routes/offramp.ts"), "let x = 1;\n  tx.sign(kp);\n");
      mkdirSync(join(root, "packages/offramp/src"), { recursive: true });
      writeFileSync(join(root, "packages/offramp/src/clean.ts"), "WebAuth.readChallengeTx(xdr);\n");

      expect(scan(root)).toEqual([
        {
          file: "apps/api/src/routes/offramp.ts",
          line: 2,
          id: ".sign(",
          why: expect.any(String),
          source: "tx.sign(kp);",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips allowlisted files exactly, and does not leak the allowance to siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "no-server-signing-"));
    try {
      const allowed = join(root, "apps/api/src/services/seller-wallet.ts");
      mkdirSync(join(root, "apps/api/src/services"), { recursive: true });
      writeFileSync(allowed, "return Keypair.fromSecret(trimmed);\n");
      // Same call, one directory over: must still fail, or the allowlist is a
      // blanket rather than a per-file review record.
      writeFileSync(join(root, "apps/api/src/services/copy.ts"), "return Keypair.fromSecret(trimmed);\n");

      expect(scan(root).map((v) => v.file)).toEqual(["apps/api/src/services/copy.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds nothing in this repository's real trees", () => {
    // The decisive assertion for #207: the deleted signing paths are gone and
    // nothing else under apps/api/src or packages/offramp/src signs either.
    expect(scan()).toEqual([]);
  });
});

describe("staleAllowlist", () => {
  it("every allowlist entry still names a file that exists", () => {
    expect(staleAllowlist()).toEqual([]);
  });

  it("reports an entry whose file has been deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "no-server-signing-"));
    try {
      expect(staleAllowlist(root).sort()).toEqual([...ALLOWLIST.keys()].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the allowlist is small and every entry carries a stated reason", () => {
    // Two entries today (challenge.ts, seller-wallet.ts). Growth here is a
    // security review, so the count is asserted rather than assumed.
    expect([...ALLOWLIST.keys()]).toEqual([
      "apps/api/src/services/challenge.ts",
      "apps/api/src/services/seller-wallet.ts",
    ]);
    for (const [file, reason] of ALLOWLIST) {
      expect(reason.length, `allowlist reason for ${file}`).toBeGreaterThan(40);
    }
    expect(SCANNED_DIRS).toEqual(["apps/api/src", "packages/offramp/src"]);
    expect(ROOT).toBeTruthy();
  });
});
