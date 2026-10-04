#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const domain = process.argv[2];
if (!domain) {
  console.error("Usage: node scripts/record-anchor-fixtures.mjs <home_domain>");
  process.exit(1);
}

function parseTomlValue(line) {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return { key, val };
}

async function record() {
  console.log(`Recording fixtures for ${domain}...`);
  const targetDir = resolve(__dirname, `../packages/offramp/test/fixtures/${domain}`);
  mkdirSync(targetDir, { recursive: true });

  // 1. Fetch stellar.toml
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  console.log(`Fetching ${tomlUrl}...`);
  const tomlRes = await fetch(tomlUrl);
  if (!tomlRes.ok) {
    throw new Error(`Failed to fetch stellar.toml from ${tomlUrl}: ${tomlRes.status}`);
  }
  const tomlText = await tomlRes.text();
  writeFileSync(resolve(targetDir, "stellar.toml"), tomlText, "utf8");

  // Extract TRANSFER_SERVER and KYC_SERVER
  let transferServer = null;
  let kycServer = null;

  for (const line of tomlText.split("\n")) {
    const parsed = parseTomlValue(line.trim());
    if (!parsed) continue;
    if (parsed.key === "TRANSFER_SERVER") transferServer = parsed.val;
    if (parsed.key === "KYC_SERVER") kycServer = parsed.val;
  }

  // 2. Fetch SEP-6 /info if TRANSFER_SERVER is defined
  let sep6Info = null;
  if (transferServer) {
    const infoUrl = `${transferServer.replace(/\/+$/, "")}/info`;
    console.log(`Fetching SEP-6 info from ${infoUrl}...`);
    try {
      const infoRes = await fetch(infoUrl);
      if (infoRes.ok) {
        sep6Info = await infoRes.json();
        writeFileSync(resolve(targetDir, "sep6-info.json"), JSON.stringify(sep6Info, null, 2) + "\n", "utf8");
      } else {
        console.warn(`SEP-6 info fetch failed with status ${infoRes.status}`);
      }
    } catch (err) {
      console.warn(`SEP-6 info fetch error:`, err);
    }
  }

  // 3. Fetch SEP-12 /customer without token if KYC_SERVER is defined
  let sep12Unauth = null;
  if (kycServer) {
    const kycUrl = `${kycServer.replace(/\/+$/, "")}/customer`;
    console.log(`Fetching unauthenticated KYC response from ${kycUrl}...`);
    try {
      const kycRes = await fetch(kycUrl);
      const status = kycRes.status;
      let bodyText = "";
      try {
        bodyText = await kycRes.text();
      } catch {}
      sep12Unauth = {
        status,
        statusText: kycRes.statusText,
        body: bodyText,
      };
      writeFileSync(resolve(targetDir, "sep12-customer-unauth.json"), JSON.stringify(sep12Unauth, null, 2) + "\n", "utf8");
    } catch (err) {
      console.warn(`SEP-12 customer fetch error:`, err);
    }
  }

  // 4. Save metadata
  const metadata = {
    domain,
    transferServer,
    kycServer,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(resolve(targetDir, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");

  console.log(`Successfully recorded fixtures to ${targetDir}`);
}

record().catch((err) => {
  console.error("Recording failed:", err);
  process.exit(1);
});
