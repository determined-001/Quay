#!/usr/bin/env tsx
/**
 * apps/api/scripts/rotate-kyc-key.ts
 *
 * Scans `seller_kyc` table, decrypts fields_encrypted using the configured keyring
 * (primary + previous keys, or legacy format), and re-encrypts using the primary key
 * (`v1:<primaryKeyId>:<base64>`).
 *
 * Usage:
 *   pnpm kyc:rotate-key [--dry-run]
 *
 * Security:
 *   Never logs or prints decrypted PII / plaintext.
 */

import { eq } from "drizzle-orm";
import { loadEnvFile, envValue, envValueOptional } from "./lib/env";
import { createDb, bootstrap } from "../src/db/client";
import { sellerKyc } from "../src/db/schema";
import {
  parsePiiKeyring,
  decryptPii,
  encryptPii,
  getBlobKeyId,
} from "../src/crypto/pii";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-n");

  const envFile = loadEnvFile();
  const primaryHex = envValue(envFile, "KYC_ENCRYPTION_KEY");
  const previousHexList = envValueOptional(envFile, "KYC_ENCRYPTION_KEY_PREVIOUS");
  const databaseUrl = envValue(envFile, "DATABASE_URL", "file:./local.db");
  const databaseAuthToken = envValueOptional(envFile, "DATABASE_AUTH_TOKEN");

  const keyring = parsePiiKeyring(primaryHex, previousHexList);
  console.log(`\n[rotate-kyc-key] Primary Key ID: ${keyring.primary.id}`);
  console.log(
    `[rotate-kyc-key] Known Key IDs in keyring: ${Array.from(keyring.all.keys()).join(", ")}`,
  );
  if (dryRun) {
    console.log("[rotate-kyc-key] Mode: DRY-RUN (no database writes will occur)");
  }

  const { db, client } = createDb(databaseUrl, databaseAuthToken);
  await bootstrap(client);

  const rows = await db.select().from(sellerKyc);
  console.log(`[rotate-kyc-key] Found ${rows.length} row(s) in seller_kyc.`);

  let upToDate = 0;
  let reencrypted = 0;
  const keyIdCounts: Record<string, number> = {};

  for (const row of rows) {
    const keyId = getBlobKeyId(row.fieldsEncrypted);
    keyIdCounts[keyId] = (keyIdCounts[keyId] ?? 0) + 1;

    if (keyId === keyring.primary.id) {
      upToDate++;
      continue;
    }

    // Decrypt using keyring (or legacy fallback)
    const plaintext = decryptPii(row.fieldsEncrypted, keyring);
    const newEncrypted = encryptPii(plaintext, keyring);

    if (!dryRun) {
      await db
        .update(sellerKyc)
        .set({
          fieldsEncrypted: newEncrypted,
          updatedAt: Date.now(),
        })
        .where(eq(sellerKyc.sellerId, row.sellerId));
    }
    reencrypted++;
  }

  console.log("\n--- Rotation Summary ---");
  console.log(`Total rows scanned:      ${rows.length}`);
  console.log(`Already on primary key:  ${upToDate}`);
  console.log(`${dryRun ? "Would re-encrypt:        " : "Successfully re-encrypted: "} ${reencrypted}`);
  console.log("Breakdown by key ID found:");
  for (const [k, count] of Object.entries(keyIdCounts)) {
    console.log(`  - ${k}: ${count} row(s)`);
  }
  console.log("------------------------\n");
}

main().catch((err) => {
  console.error(
    "\n[rotate-kyc-key] fatal:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
