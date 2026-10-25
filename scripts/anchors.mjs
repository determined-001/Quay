#!/usr/bin/env node
// Operator CLI for the anchors table (issue 3.21): which anchors this
// deployment can cash out through.
//
//   node scripts/anchors.mjs list
//   node scripts/anchors.mjs add <home_domain> --url https://anchor.example \
//        [--name "Anchor"] [--protocol auto|sep6|sep24] [--withdraw-type bank_account] \
//        [--corridors NGN,KES] [--rate-source sep38|static|http] [--disabled]
//   node scripts/anchors.mjs enable  <home_domain>
//   node scripts/anchors.mjs disable <home_domain>
//
// Uses DATABASE_URL / DATABASE_AUTH_TOKEN, the same as the API (a .env in the
// working directory is read if present). The running API re-reads the table
// every few seconds, so no restart is needed. Nothing secret is stored: an
// anchor is a public domain plus how to reach it.
//
// A disabled anchor takes no new cash-outs but its in-flight withdrawals keep
// polling. `corridors` lists the payout currencies it serves; empty means any.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const PROTOCOLS = ["auto", "sep6", "sep24"];
const RATE_SOURCES = ["sep38", "static", "http"];
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i;
const CURRENCY_RE = /^[A-Za-z0-9]{2,12}$/;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export class UsageError extends Error {}

function newId() {
  let out = "";
  for (const b of randomBytes(10)) out += ALPHABET[b % 36];
  return `anc_${out}`;
}

/** `--flag value` pairs and bare `--switch`es after the positionals. */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

/** Validates `add` input and returns the row to insert. Throws UsageError. */
export function buildAnchorRow(homeDomain, flags, now = Date.now(), id = newId()) {
  if (!homeDomain || !HOST_RE.test(homeDomain)) {
    throw new UsageError(`home_domain must be a bare host name like anchor.example.com (got "${homeDomain ?? ""}")`);
  }
  const url = flags.url;
  if (typeof url !== "string") throw new UsageError("--url <https://base-url> is required");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`--url "${url}" is not a URL`);
  }
  if (parsed.protocol !== "https:") throw new UsageError("--url must be https://");

  const protocol = flags.protocol ?? "auto";
  if (!PROTOCOLS.includes(protocol)) throw new UsageError(`--protocol must be one of ${PROTOCOLS.join(", ")}`);

  const rateSource = flags["rate-source"] ?? null;
  if (rateSource !== null && !RATE_SOURCES.includes(rateSource)) {
    throw new UsageError(`--rate-source must be one of ${RATE_SOURCES.join(", ")}`);
  }

  const corridors =
    typeof flags.corridors === "string"
      ? [...new Set(flags.corridors.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean))]
      : [];
  for (const c of corridors) {
    if (!CURRENCY_RE.test(c)) throw new UsageError(`--corridors entry "${c}" is not a currency code`);
  }

  const name = typeof flags.name === "string" && flags.name.trim() ? flags.name.trim() : homeDomain;
  const withdrawType = typeof flags["withdraw-type"] === "string" ? flags["withdraw-type"] : null;

  return {
    id,
    home_domain: homeDomain.toLowerCase(),
    base_url: url.replace(/\/+$/, ""),
    display_name: name,
    enabled: flags.disabled ? 0 : 1,
    protocol,
    withdraw_type: withdrawType,
    corridors: JSON.stringify(corridors),
    rate_source: rateSource,
    created_at: now,
    updated_at: now,
  };
}

export async function listAnchors(client) {
  const res = await client.execute(
    "SELECT home_domain, display_name, enabled, protocol, withdraw_type, corridors, rate_source FROM anchors ORDER BY created_at, home_domain",
  );
  return res.rows.map((r) => ({
    homeDomain: String(r.home_domain),
    displayName: String(r.display_name),
    enabled: Number(r.enabled) === 1,
    protocol: String(r.protocol),
    withdrawType: r.withdraw_type === null ? null : String(r.withdraw_type),
    corridors: JSON.parse(String(r.corridors)),
    rateSource: r.rate_source === null ? null : String(r.rate_source),
  }));
}

export async function addAnchor(client, row) {
  const existing = await client.execute({ sql: "SELECT 1 FROM anchors WHERE home_domain = ?", args: [row.home_domain] });
  if (existing.rows.length > 0) throw new UsageError(`${row.home_domain} is already in the anchors table`);
  await client.execute({
    sql: `INSERT INTO anchors (id, home_domain, base_url, display_name, enabled, protocol, withdraw_type, corridors, rate_source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id, row.home_domain, row.base_url, row.display_name, row.enabled, row.protocol,
      row.withdraw_type, row.corridors, row.rate_source, row.created_at, row.updated_at,
    ],
  });
}

export async function setEnabled(client, homeDomain, enabled, now = Date.now()) {
  const res = await client.execute({
    sql: "UPDATE anchors SET enabled = ?, updated_at = ? WHERE home_domain = ? COLLATE NOCASE",
    args: [enabled ? 1 : 0, now, homeDomain],
  });
  if (res.rowsAffected === 0) throw new UsageError(`${homeDomain} is not in the anchors table`);
}

export function formatList(rows) {
  if (rows.length === 0) return "No anchors. Add one with: node scripts/anchors.mjs add <home_domain> --url https://...";
  return rows
    .map(
      (r) =>
        `${r.enabled ? "enabled " : "disabled"}  ${r.homeDomain}  protocol=${r.protocol}` +
        `  corridors=${r.corridors.length ? r.corridors.join(",") : "any"}` +
        `${r.withdrawType ? `  withdraw_type=${r.withdrawType}` : ""}${r.rateSource ? `  rate_source=${r.rateSource}` : ""}`,
    )
    .join("\n");
}

const USAGE = `usage:
  node scripts/anchors.mjs list
  node scripts/anchors.mjs add <home_domain> --url https://anchor.example [--name N] [--protocol auto|sep6|sep24]
                              [--withdraw-type T] [--corridors NGN,KES] [--rate-source sep38|static|http] [--disabled]
  node scripts/anchors.mjs enable <home_domain>
  node scripts/anchors.mjs disable <home_domain>`;

async function main(argv) {
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env here: DATABASE_URL must come from the environment.
  }
  const { positionals, flags } = parseArgs(argv);
  const [command, domain] = positionals;
  if (!["list", "add", "enable", "disable"].includes(command ?? "")) throw new UsageError(USAGE);

  const client = createClient({
    url: process.env.DATABASE_URL || "file:./local.db",
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  });
  try {
    if (command === "list") console.log(formatList(await listAnchors(client)));
    else if (command === "add") {
      const row = buildAnchorRow(domain, flags);
      await addAnchor(client, row);
      console.log(`added ${row.home_domain} (${row.enabled ? "enabled" : "disabled"})`);
    } else {
      if (!domain) throw new UsageError(USAGE);
      await setEnabled(client, domain, command === "enable");
      console.log(`${command}d ${domain}`);
    }
  } catch (err) {
    if (err instanceof Error && /no such table: anchors/i.test(err.message)) {
      throw new UsageError("The anchors table does not exist yet. Start the API once so it can run its migrations.");
    }
    throw err;
  } finally {
    client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof UsageError ? err.message : `anchors: ${err instanceof Error ? err.message : err}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
