#!/usr/bin/env node
/**
 * One-off repair for issue 5.21: `offramp_telemetry.quoted_rate` on rows
 * written by real (non-mock) anchors stored the SEP-38 `price` — SELL units
 * per BUY unit — while the effective rate is measured as TARGET per source.
 * The adapters now return target-per-source; this inverts the historical
 * rows so the whole dataset speaks one unit.
 *
 *   node apps/api/scripts/fix-telemetry-rate-units.mjs             # dry run
 *   node apps/api/scripts/fix-telemetry-rate-units.mjs --apply     # write
 *
 * Dry-run is the DEFAULT and prints exactly what --apply would change.
 * Mock rows (`anchor_domain = 'mock'`) were already target-per-source and
 * are never touched. RUN THIS AT MOST ONCE per database: quoted_rate carries
 * no unit tag, so a second --apply would invert the values back to wrong.
 * See docs/RUNBOOK.md § "Telemetry rate-unit repair".
 *
 * Historical `fee_amount` on the same rows was computed across the mixed
 * units and is NOT recomputed here (the settled target amounts needed to
 * redo it faithfully are on the rows, but the issue scopes this script to
 * quoted_rate); treat pre-fix fee_amount on non-mock rows as unreliable.
 */
import { createClient } from "@libsql/client";

const url = process.env.DATABASE_URL || "file:./local.db";
const authToken = process.env.DATABASE_AUTH_TOKEN || undefined;
const apply = process.argv.includes("--apply");

const client = createClient({ url, authToken });

let rows;
try {
  ({ rows } = await client.execute(
    "SELECT id, anchor_domain, corridor, quoted_rate FROM offramp_telemetry WHERE anchor_domain != 'mock'",
  ));
} catch (err) {
  if (String(err).includes("no such table")) {
    console.log("offramp_telemetry does not exist in this database — nothing to repair");
    process.exit(0);
  }
  throw err;
}

if (rows.length === 0) {
  console.log("no non-mock telemetry rows — nothing to do");
  process.exit(0);
}

let changed = 0;
for (const row of rows) {
  const rate = Number(row.quoted_rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    console.warn(`skip ${row.id} (${row.corridor}): unusable quoted_rate ${JSON.stringify(row.quoted_rate)}`);
    continue;
  }
  const inverted = (1 / rate).toFixed(8);
  console.log(
    `${apply ? "fix " : "would fix "}${row.id} ${row.anchor_domain} ${row.corridor}: ${row.quoted_rate} -> ${inverted}`,
  );
  if (apply) {
    await client.execute({
      sql: "UPDATE offramp_telemetry SET quoted_rate = ? WHERE id = ?",
      args: [inverted, row.id],
    });
  }
  changed += 1;
}

console.log(
  apply
    ? `inverted quoted_rate on ${changed} row(s)`
    : `dry run: ${changed} row(s) would change — rerun with --apply to write`,
);
