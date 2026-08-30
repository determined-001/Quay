#!/usr/bin/env node
/**
 * Which pubnet anchors implement SEP-6 (non-interactive) but NOT SEP-24
 * (anchor-hosted UI)?
 *
 * That gap is the whole question behind building a checkout for anchors. Under
 * SEP-6 the anchor deliberately outsources the interface and SEP-12 KYC
 * collection to the client; under SEP-24 it hosts its own webview and needs
 * nobody's checkout. So "SEP-6 and not SEP-24" is the addressable set, and its
 * size decides whether this is a product or a consulting gig.
 *
 *   node scripts/anchor-sep-scan.mjs [--min-holders N] [--max-pages N] [--out FILE]
 *
 * Method, and its limits:
 *
 *  1. Page Horizon /assets. Every asset carries a `_links.toml` pointing at its
 *     issuer's home domain, which is how an issuer is discovered without
 *     depending on a curated directory (stellar.org/anchor-directory 404s, and
 *     a directory only lists anchors that chose to register).
 *  2. Filter by trustline holders. Pubnet is full of tokens with single-digit
 *     holders; an anchor with a real off-ramp has many. This is a proxy, not a
 *     truth — a new legitimate anchor can sit below the threshold.
 *  3. Fetch each domain's stellar.toml and read which transfer servers it
 *     declares. Per SEP-1, TRANSFER_SERVER means SEP-6 and
 *     TRANSFER_SERVER_SEP0024 means SEP-24.
 *
 * A domain that fails to serve a TOML is reported as unreachable rather than
 * silently dropped — treating a network failure as "no SEP-6" would understate
 * exactly the number this exists to measure.
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const MIN_HOLDERS = Number(flag("--min-holders", "25"));
const MAX_PAGES = Number(flag("--max-pages", "200"));
const OUT = flag("--out", "anchor-sep-scan.json");
/**
 * Optional JSON file holding a pre-built array of domains, which skips the
 * Horizon phase entirely.
 *
 * The curated route is better when it is available: StellarExpert's directory
 * (`/explorer/directory?tag[]=anchor`) is hand-tagged, so it yields ~160
 * plausible domains instead of tens of thousands of assets, most of which are
 * vanity tokens. The Horizon path stays as the fallback because a curated list
 * only contains anchors somebody bothered to tag — it will miss new ones, and
 * missing anchors is the failure mode that matters here.
 */
const DOMAINS_FILE = flag("--domains", null);
const CONCURRENCY = 12;
const TOML_TIMEOUT_MS = 12_000;

const HORIZON = "https://horizon.stellar.org";

/** SEP-1 keys that tell us what the anchor actually implements. */
const KEYS = [
  "TRANSFER_SERVER", // SEP-6
  "TRANSFER_SERVER_SEP0024", // SEP-24
  "DIRECT_PAYMENT_SERVER", // SEP-31
  "ANCHOR_QUOTE_SERVER", // SEP-38
  "KYC_SERVER", // SEP-12
  "WEB_AUTH_ENDPOINT", // SEP-10
  "SIGNING_KEY",
  "NETWORK_PASSPHRASE",
];

/**
 * Minimal SEP-1 reader.
 *
 * Only root-level keys count. A stellar.toml's [[CURRENCIES]] entries can carry
 * their own keys, and a naive line grep would read one of those as the anchor's
 * transfer server — which would misclassify the exact thing being counted.
 */
function parseToml(text) {
  const out = {};
  let atRoot = true;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      atRoot = false; // entered [SECTION] or [[ARRAY]]; never returns to root
      continue;
    }
    if (!atRoot) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEYS.includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return out;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "quay-anchor-sep-scan" },
    });
  } finally {
    clearTimeout(t);
  }
}

/** Phase 1 — discover candidate issuer domains from Horizon. */
async function discoverDomains() {
  const domains = new Map(); // domain -> { assets:Set, holders:number }
  let url = `${HORIZON}/assets?limit=200`;
  let pages = 0;
  let assets = 0;

  while (url && pages < MAX_PAGES) {
    let data;
    try {
      const res = await fetchWithTimeout(url, 30_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      process.stderr.write(`\n[horizon] page ${pages} failed: ${err.message}; stopping early\n`);
      break;
    }
    const records = data._embedded?.records ?? [];
    if (records.length === 0) break;
    assets += records.length;

    for (const rec of records) {
      const holders = rec.accounts?.authorized ?? 0;
      if (holders < MIN_HOLDERS) continue;
      const href = rec._links?.toml?.href;
      if (!href || !href.startsWith("https://")) continue;
      let host;
      try {
        host = new URL(href).host.toLowerCase();
      } catch {
        continue;
      }
      if (!host || host.includes(" ")) continue;
      const entry = domains.get(host) ?? { assets: new Set(), holders: 0 };
      entry.assets.add(rec.asset_code);
      entry.holders = Math.max(entry.holders, holders);
      domains.set(host, entry);
    }

    url = data._links?.next?.href ?? null;
    pages += 1;
    process.stderr.write(
      `\r[horizon] page ${pages} · ${assets} assets · ${domains.size} candidate domains`,
    );
  }
  process.stderr.write("\n");
  return { domains, pages, assets };
}

/** Phase 2 — fetch and classify each domain's stellar.toml. */
async function classify(domains, writeFile) {
  const entries = [...domains.entries()];
  const results = [];
  let done = 0;
  let lastFlush = 0;

  async function worker() {
    for (;;) {
      const next = entries.shift();
      if (!next) return;
      const [domain, meta] = next;
      const row = {
        domain,
        assetCodes: [...meta.assets].sort(),
        maxHolders: meta.holders,
        reachable: false,
        seps: {},
        classification: "unreachable",
        error: null,
      };
      try {
        const res = await fetchWithTimeout(
          `https://${domain}/.well-known/stellar.toml`,
          TOML_TIMEOUT_MS,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const toml = parseToml(text);
        row.reachable = true;
        row.seps = toml;

        const sep6 = Boolean(toml.TRANSFER_SERVER);
        const sep24 = Boolean(toml.TRANSFER_SERVER_SEP0024);
        row.classification =
          sep6 && sep24 ? "both" : sep6 ? "sep6_only" : sep24 ? "sep24_only" : "no_transfer_server";
      } catch (err) {
        row.error = err.name === "AbortError" ? "timeout" : err.message;
      }
      results.push(row);
      done += 1;
      process.stderr.write(`\r[toml] ${done}/${domains.size} checked`);
      // Flush periodically so a killed run still yields usable partial data.
      if (done - lastFlush >= 25) {
        lastFlush = done;
        await writeFile(`${OUT}.partial.json`, JSON.stringify(results, null, 2)).catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");
  return results;
}

const { writeFile } = await import("node:fs/promises");

let domains, pages, assets;
if (DOMAINS_FILE) {
  const { readFile } = await import("node:fs/promises");
  const list = JSON.parse(await readFile(DOMAINS_FILE, "utf8"));
  domains = new Map(
    list.map((d) => [String(d).toLowerCase(), { assets: new Set(), holders: 0 }]),
  );
  pages = 0;
  assets = 0;
  process.stderr.write(`[domains] ${domains.size} loaded from ${DOMAINS_FILE}\n`);
} else {
  ({ domains, pages, assets } = await discoverDomains());
}

// Checkpoint the discovery phase before the (slower) TOML phase starts.
// Paging Horizon takes minutes; losing it to a killed process means redoing
// the expensive part to learn nothing new.
await writeFile(
  `${OUT}.domains.json`,
  JSON.stringify(
    { pages, assets, minHolders: MIN_HOLDERS, domains: [...domains.keys()].sort() },
    null,
    2,
  ),
);

const rows = await classify(domains, writeFile);

const by = (c) => rows.filter((r) => r.classification === c);
const sep6Only = by("sep6_only").sort((a, b) => b.maxHolders - a.maxHolders);
const both = by("both").sort((a, b) => b.maxHolders - a.maxHolders);
const sep24Only = by("sep24_only");
const none = by("no_transfer_server");
const unreachable = by("unreachable");

const summary = {
  scannedAt: new Date().toISOString(),
  horizonPages: pages,
  assetsSeen: assets,
  minHolders: MIN_HOLDERS,
  candidateDomains: domains.size,
  sep6Only: sep6Only.length,
  both: both.length,
  sep24Only: sep24Only.length,
  noTransferServer: none.length,
  unreachable: unreachable.length,
};

await writeFile(
  OUT,
  JSON.stringify({ summary, rows: rows.sort((a, b) => b.maxHolders - a.maxHolders) }, null, 2),
);

const line = "─".repeat(72);
const out = [
  "",
  line,
  "  PUBNET ANCHOR SEP SCAN",
  line,
  ...(DOMAINS_FILE
    ? [`  Domain source          ${DOMAINS_FILE}`]
    : [
        `  Horizon pages          ${pages}`,
        `  Assets seen            ${assets}`,
        `  Min trustline holders  ${MIN_HOLDERS}`,
      ]),
  `  Candidate domains      ${domains.size}`,
  "",
  `  SEP-6 only (no hosted UI — ADDRESSABLE)   ${sep6Only.length}`,
  `  SEP-6 and SEP-24 (both)                   ${both.length}`,
  `  SEP-24 only (hosts its own UI)            ${sep24Only.length}`,
  `  No transfer server (not an anchor)        ${none.length}`,
  `  Unreachable / no TOML                     ${unreachable.length}`,
  line,
];

if (sep6Only.length) {
  out.push("", "  SEP-6 ONLY — anchors with no hosted checkout of their own:", "");
  for (const r of sep6Only) {
    const sep38 = r.seps.ANCHOR_QUOTE_SERVER ? " +SEP-38" : "";
    const sep12 = r.seps.KYC_SERVER ? " +SEP-12" : "";
    const sep10 = r.seps.WEB_AUTH_ENDPOINT ? " +SEP-10" : "";
    out.push(`    ${r.domain.padEnd(40)}${sep10}${sep12}${sep38}`);
  }
}

out.push("", `  Full results: ${OUT}`, "");
process.stdout.write(out.join("\n") + "\n");
