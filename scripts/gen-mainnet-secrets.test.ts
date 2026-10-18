import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CIRCLE_USDC_ISSUER_PUBNET,
  checkSellerWallet,
  runStaticChecks,
} from "./mainnet-preflight.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCRIPT_PATH = resolve(__dirname, "../apps/api/scripts/gen-mainnet-secrets.mjs");

const WALLET = "GBMDH3QWSD74ILWD2ZVFOAOCMVRNPNGAHN557WA4KABLI5IFN2XYLMGY";

/** A configuration matching GOOD from mainnet-preflight.test.ts. */
const GOOD = {
  STELLAR_NETWORK: "public",
  SINGLE_INSTANCE: "true",
  DATABASE_URL: "libsql://quay-prod.turso.io",
  DATABASE_AUTH_TOKEN: "tok",
  USDC_ISSUER_PUBLIC: CIRCLE_USDC_ISSUER_PUBNET,
  OFFRAMP: "none",
  NEXT_PUBLIC_OFFRAMP_MODE: "none",
  NEXT_PUBLIC_STELLAR_NETWORK: "public",
  DEFAULT_SELLER_WALLET: WALLET,
  SERVER_SIGNING_SECRET: "S" + "A".repeat(55),
  JWT_SECRET: "a".repeat(64),
  WEBHOOK_SECRET_ENCRYPTION_KEY: "b".repeat(64),
  METRICS_TOKEN: "c".repeat(64),
};

const EXPECTED_KEYS = [
  "JWT_SECRET",
  "KYC_ENCRYPTION_KEY",
  "WEBHOOK_SECRET_ENCRYPTION_KEY",
  "METRICS_TOKEN",
  "SERVER_SIGNING_SECRET",
].sort();

function parseKeyValues(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

describe("gen-mainnet-secrets.mjs", () => {
  it("executes cleanly and outputs the expected set of secrets without seller keys", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    const parsed = parseKeyValues(stdout);

    // No key beginning with DEFAULT_SELLER is printed
    const sellerKeys = Object.keys(parsed).filter((k) => k.startsWith("DEFAULT_SELLER"));
    expect(sellerKeys).toEqual([]);
    expect(stdout).not.toMatch(/^DEFAULT_SELLER/m);

    // Expected keys are exactly the 5 required secrets
    expect(Object.keys(parsed).sort()).toEqual(EXPECTED_KEYS);

    // Symmetric keys are 64 hex characters (32 bytes)
    expect(parsed.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.KYC_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.WEBHOOK_SECRET_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.METRICS_TOKEN).toMatch(/^[0-9a-f]{64}$/);

    // SERVER_SIGNING_SECRET is a Stellar secret key (starts with 'S', length 56)
    expect(parsed.SERVER_SIGNING_SECRET).toMatch(/^S[A-Z2-7]{55}$/);
  });

  it("includes explanatory notes matching the multi-tenant architecture", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });

    // Note that no seller key is needed and DEFAULT_SELLER_WALLET is optional
    expect(stdout).toMatch(/No seller key is needed because every seller signs with their own wallet/);
    expect(stdout).toMatch(/DEFAULT_SELLER_WALLET is optional \(public address only\)/);
  });

  it("merged into the GOOD config from mainnet-preflight.test.ts, passes static checks", () => {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    const parsed = parseKeyValues(stdout);
    const merged = { ...GOOD, ...parsed };

    const staticCheckResults = runStaticChecks(merged);
    const blockingFailures = staticCheckResults.filter((r) => !r.ok && r.level === "blocking");
    expect(blockingFailures).toEqual([]);

    const sellerCheck = checkSellerWallet(merged);
    expect(sellerCheck.ok).toBe(true);
  });
});
