// SEP-1: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md
//
// The anchor's stellar.toml is the only thing that makes anchors interchangeable:
// it advertises WEB_AUTH_ENDPOINT (SEP-10), TRANSFER_SERVER (SEP-6), KYC_SERVER
// (SEP-12), ANCHOR_QUOTE_SERVER (SEP-38), the SIGNING_KEY that SEP-10 challenges
// must be signed by, and the CURRENCIES actually supported. Discovering these
// instead of hard-coding paths is what turns a per-anchor fork into config.
//
// Deliberately no TOML library: SEP-1 needs a narrow subset (top-level
// key/values, `[[CURRENCIES]]` arrays-of-tables, `[DOCUMENTATION]`-style
// tables), and `smol-toml` is only a transitive dependency of the Stellar SDK —
// importing it here would be an undeclared dependency that a hoisting change
// could break. `parseToml` below covers exactly the subset SEP-1 defines.

/** One entry from the TOML's `[[CURRENCIES]]` list. */
export interface StellarTomlCurrency {
  code: string | null;
  issuer: string | null;
  status: string | null;
  isAssetAnchored: boolean | null;
  anchorAssetType: string | null;
  desc: string | null;
}

/** The SEP-1 fields this off-ramp depends on, plus the raw table for anything else. */
export interface StellarToml {
  homeDomain: string;
  /** Ed25519 public key the anchor signs SEP-10 challenges with. */
  signingKey: string | null;
  networkPassphrase: string | null;
  /** SEP-10 web auth. */
  webAuthEndpoint: string | null;
  /** SEP-6 deposit/withdraw. */
  transferServer: string | null;
  /** SEP-24 interactive deposit/withdraw — not used by this adapter today. */
  transferServerSep24: string | null;
  /** SEP-12 KYC. */
  kycServer: string | null;
  /** SEP-38 quotes. */
  anchorQuoteServer: string | null;
  currencies: StellarTomlCurrency[];
  /** Everything parsed, for fields this interface doesn't name. */
  raw: Record<string, TomlValue>;
}

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

export class StellarTomlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellarTomlError";
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TOML_BYTES = 100 * 1024; // SEP-1 caps stellar.toml at 100 KB.
const DEFAULT_TIMEOUT_MS = 10_000;

interface CacheEntry {
  toml: StellarToml;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
/** In-flight de-duplication: N concurrent callers on a cold cache issue one GET. */
const inFlight = new Map<string, Promise<StellarToml>>();

export interface FetchStellarTomlOptions {
  /** Reject if the TOML's NETWORK_PASSPHRASE is present and doesn't match. */
  expectedNetworkPassphrase?: string;
  /** Bypass the 5-minute cache for this call. */
  forceRefresh?: boolean;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Drops every cached TOML. Exported for tests — the cache is process-global. */
export function clearStellarTomlCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Fetches and parses `https://<homeDomain>/.well-known/stellar.toml`, cached for
 * 5 minutes per home domain.
 *
 * When `expectedNetworkPassphrase` is given and the TOML declares a
 * NETWORK_PASSPHRASE, a mismatch throws: pointing a testnet build at a mainnet
 * anchor (or the reverse) must fail loudly at discovery, not silently produce a
 * challenge our keypair signs on the wrong network.
 */
export async function fetchStellarToml(
  homeDomain: string,
  opts: FetchStellarTomlOptions = {},
): Promise<StellarToml> {
  const domain = normalizeHomeDomain(homeDomain);

  if (!opts.forceRefresh) {
    const hit = cache.get(domain);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
      assertNetwork(hit.toml, opts.expectedNetworkPassphrase);
      return hit.toml;
    }
    const pending = inFlight.get(domain);
    if (pending) {
      const toml = await pending;
      assertNetwork(toml, opts.expectedNetworkPassphrase);
      return toml;
    }
  }

  const task = loadStellarToml(domain, opts).finally(() => inFlight.delete(domain));
  inFlight.set(domain, task);

  const toml = await task;
  cache.set(domain, { toml, fetchedAt: Date.now() });
  // Validated after caching: the document is legitimately what the domain
  // serves, it's just not the network *this* caller wanted. Another caller on a
  // different network shouldn't have to re-fetch to find that out.
  assertNetwork(toml, opts.expectedNetworkPassphrase);
  return toml;
}

async function loadStellarToml(domain: string, opts: FetchStellarTomlOptions): Promise<StellarToml> {
  const url = `https://${domain}/.well-known/stellar.toml`;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new StellarTomlError(
      `SEP-1 discovery failed for ${domain}: could not fetch ${url} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) {
    throw new StellarTomlError(`SEP-1 discovery failed for ${domain}: ${url} returned ${res.status}`);
  }

  const text = await res.text();
  if (text.length > MAX_TOML_BYTES) {
    throw new StellarTomlError(
      `SEP-1 discovery failed for ${domain}: stellar.toml is ${text.length} bytes, over the 100 KB SEP-1 limit`,
    );
  }

  let table: Record<string, TomlValue>;
  try {
    table = parseToml(text);
  } catch (err) {
    throw new StellarTomlError(
      `SEP-1 discovery failed for ${domain}: stellar.toml is not valid TOML (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return toStellarToml(domain, table);
}

function assertNetwork(toml: StellarToml, expected: string | undefined): void {
  if (!expected) return;
  // Absent is tolerated (SEP-1 does not require it); present-and-wrong is not.
  if (toml.networkPassphrase === null) return;
  if (toml.networkPassphrase !== expected) {
    throw new StellarTomlError(
      `SEP-1 network mismatch for ${toml.homeDomain}: anchor declares NETWORK_PASSPHRASE ` +
        `"${toml.networkPassphrase}" but this deployment is on "${expected}". Refusing to talk to it.`,
    );
  }
}

/** Strips scheme, port, path, and a trailing dot so `https://a.com/x` and `a.com` share a cache key. */
export function normalizeHomeDomain(homeDomain: string): string {
  const trimmed = homeDomain.trim();
  if (!trimmed) throw new StellarTomlError("homeDomain is required for SEP-1 discovery");
  const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split("/")[0] ?? "";
  const bare = host.split("@").pop() ?? host; // drop any userinfo
  const noPort = bare.replace(/:\d+$/, "");
  const normalized = noPort.replace(/\.$/, "").toLowerCase();
  if (!normalized) throw new StellarTomlError(`"${homeDomain}" is not a usable home domain`);
  return normalized;
}

function toStellarToml(homeDomain: string, table: Record<string, TomlValue>): StellarToml {
  return {
    homeDomain,
    signingKey: str(table.SIGNING_KEY),
    networkPassphrase: str(table.NETWORK_PASSPHRASE),
    webAuthEndpoint: str(table.WEB_AUTH_ENDPOINT),
    transferServer: str(table.TRANSFER_SERVER),
    transferServerSep24: str(table.TRANSFER_SERVER_SEP0024),
    kycServer: str(table.KYC_SERVER),
    anchorQuoteServer: str(table.ANCHOR_QUOTE_SERVER),
    currencies: toCurrencies(table.CURRENCIES),
    raw: table,
  };
}

function str(v: TomlValue | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toCurrencies(v: TomlValue | undefined): StellarTomlCurrency[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is { [k: string]: TomlValue } => typeof e === "object" && e !== null && !Array.isArray(e))
    .map((e) => ({
      code: str(e.code),
      issuer: str(e.issuer),
      status: str(e.status),
      isAssetAnchored: typeof e.is_asset_anchored === "boolean" ? e.is_asset_anchored : null,
      anchorAssetType: str(e.anchor_asset_type),
      desc: str(e.desc),
    }));
}

/**
 * Finds the `[[CURRENCIES]]` entry for an asset. `issuer === null` means the
 * native asset, which SEP-1 lists as `code = "native"` with no issuer.
 *
 * Returns `undefined` when the TOML lists no currencies at all — callers must
 * treat "nothing advertised" as unknown rather than as a rejection, since
 * CURRENCIES may legitimately be published at a `CURRENCIES` URL we don't follow.
 */
export function findCurrency(
  toml: StellarToml,
  asset: { code: string; issuer: string | null },
): StellarTomlCurrency | null | undefined {
  if (toml.currencies.length === 0) return undefined;
  const wantNative = asset.issuer === null;
  const match = toml.currencies.find((c) => {
    if (wantNative) return c.code === "native" || (c.code === asset.code && c.issuer === null);
    return c.code === asset.code && c.issuer === asset.issuer;
  });
  return match ?? null;
}

// ---------------------------------------------------------------------------
//  Minimal TOML parser — the SEP-1 subset only.
// ---------------------------------------------------------------------------
// Supports: comments, `key = value` pairs, `[table]`, `[[array.of.tables]]`,
// dotted table paths, basic/literal/multi-line strings, integers, floats,
// booleans, and inline arrays (including multi-line arrays). Enough for every
// field SEP-1 defines. Datetimes and inline tables are returned as raw strings
// rather than parsed — SEP-1 uses neither for anything we read.

export function parseToml(input: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  let current: Record<string, TomlValue> = root;

  const lines = stripBom(input).split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    i++;
    const line = stripComment(raw).trim();
    if (!line) continue;

    // [[array of tables]]
    const arrayTable = /^\[\[(.+?)\]\]$/.exec(line);
    if (arrayTable) {
      const path = splitKeyPath(arrayTable[1] as string);
      const arr = ensureArray(root, path);
      const entry: Record<string, TomlValue> = {};
      arr.push(entry);
      current = entry;
      continue;
    }

    // [table]
    const stdTable = /^\[(.+?)\]$/.exec(line);
    if (stdTable) {
      current = ensureTable(root, splitKeyPath(stdTable[1] as string));
      continue;
    }

    // key = value
    const eq = findAssignment(line);
    if (eq < 0) throw new Error(`unparsable line: ${line.slice(0, 60)}`);
    const key = line.slice(0, eq).trim();
    let valueText = line.slice(eq + 1).trim();
    if (!key) throw new Error(`missing key in: ${line.slice(0, 60)}`);

    // Multi-line string / array: keep consuming lines until it closes.
    const multiline = openMultiline(valueText);
    if (multiline) {
      const collected: string[] = [valueText];
      while (i < lines.length && !closesMultiline(collected.join("\n"), multiline)) {
        collected.push(lines[i] ?? "");
        i++;
      }
      valueText = collected.join("\n");
    }

    const path = splitKeyPath(key);
    const leaf = path.pop() as string;
    const target = path.length ? ensureTable(current, path) : current;
    target[leaf] = parseValue(valueText, multiline === "array");
  }

  return root;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Removes a `#` comment, respecting quoted strings. */
function stripComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === "\\") i++;
      else if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Index of the `=` that separates key from value, ignoring quoted keys. */
function findAssignment(line: string): number {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === "\\") i++;
      else if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "=") return i;
  }
  return -1;
}

type Multiline = "array" | "basic" | "literal";

function openMultiline(valueText: string): Multiline | null {
  if (valueText.startsWith('"""') && !closesTriple(valueText, '"""')) return "basic";
  if (valueText.startsWith("'''") && !closesTriple(valueText, "'''")) return "literal";
  if (valueText.startsWith("[") && !bracketsBalanced(valueText)) return "array";
  return null;
}

function closesMultiline(text: string, kind: Multiline): boolean {
  if (kind === "array") return bracketsBalanced(text);
  return closesTriple(text, kind === "basic" ? '"""' : "'''");
}

function closesTriple(text: string, delim: string): boolean {
  return text.length > delim.length * 2 - 1 && text.slice(delim.length).includes(delim);
}

function bracketsBalanced(text: string): boolean {
  let depth = 0;
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inBasic) {
      if (ch === "\\") i++;
      else if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth <= 0;
}

function splitKeyPath(key: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i] as string;
    if (inBasic) {
      if (ch === '"') inBasic = false;
      else buf += ch;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      else buf += ch;
      continue;
    }
    if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === ".") {
      parts.push(buf.trim());
      buf = "";
    } else buf += ch;
  }
  parts.push(buf.trim());
  const cleaned = parts.filter((p) => p.length > 0);
  if (cleaned.length === 0) throw new Error(`empty key path: ${key}`);
  return cleaned;
}

function ensureTable(root: Record<string, TomlValue>, path: string[]): Record<string, TomlValue> {
  let node: Record<string, TomlValue> = root;
  for (const part of path) {
    const existing = node[part];
    if (Array.isArray(existing)) {
      // Dotted path into the most recent [[array of tables]] entry.
      const last = existing[existing.length - 1];
      if (typeof last === "object" && last !== null && !Array.isArray(last)) {
        node = last as Record<string, TomlValue>;
        continue;
      }
      throw new Error(`cannot descend into array key "${part}"`);
    }
    if (typeof existing === "object" && existing !== null) {
      node = existing as Record<string, TomlValue>;
      continue;
    }
    if (existing !== undefined) throw new Error(`key "${part}" is already a scalar`);
    const created: Record<string, TomlValue> = {};
    node[part] = created;
    node = created;
  }
  return node;
}

function ensureArray(root: Record<string, TomlValue>, path: string[]): TomlValue[] {
  const leaf = path[path.length - 1] as string;
  const parent = path.length > 1 ? ensureTable(root, path.slice(0, -1)) : root;
  const existing = parent[leaf];
  if (Array.isArray(existing)) return existing;
  if (existing !== undefined) throw new Error(`key "${leaf}" is not an array of tables`);
  const created: TomlValue[] = [];
  parent[leaf] = created;
  return created;
}

function parseValue(text: string, isArray: boolean): TomlValue {
  const v = text.trim();
  if (!v) throw new Error("missing value");

  if (isArray || v.startsWith("[")) return parseArray(v);
  if (v.startsWith('"""')) return unescapeBasic(trimTriple(v, '"""'));
  if (v.startsWith("'''")) return trimTriple(v, "'''");
  if (v.startsWith('"')) return unescapeBasic(trimQuoted(v, '"'));
  if (v.startsWith("'")) return trimQuoted(v, "'");
  if (v === "true") return true;
  if (v === "false") return false;

  const num = parseNumber(v);
  if (num !== null) return num;

  // Datetimes and anything else exotic: hand back verbatim. SEP-1 reads none
  // of these as structured values, and losing the text would be worse.
  return v;
}

function parseNumber(v: string): number | null {
  const cleaned = v.replace(/_/g, "");
  if (!/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(cleaned)) {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function trimQuoted(v: string, quote: string): string {
  const end = v.lastIndexOf(quote);
  if (end <= 0) throw new Error(`unterminated string: ${v.slice(0, 40)}`);
  return v.slice(1, end);
}

function trimTriple(v: string, delim: string): string {
  const end = v.lastIndexOf(delim);
  if (end < delim.length) throw new Error(`unterminated multi-line string: ${v.slice(0, 40)}`);
  let body = v.slice(delim.length, end);
  // TOML trims a newline immediately after the opening delimiter.
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return body;
}

function unescapeBasic(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, esc: string) => {
    switch (esc) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        if (esc[0] === "u" || esc[0] === "U") {
          const cp = Number.parseInt(esc.slice(1), 16);
          return Number.isNaN(cp) ? esc : String.fromCodePoint(cp);
        }
        return esc;
    }
  });
}

function parseArray(text: string): TomlValue[] {
  const body = text.trim();
  if (!body.startsWith("[")) throw new Error(`not an array: ${body.slice(0, 40)}`);
  const close = body.lastIndexOf("]");
  if (close < 1) throw new Error(`unterminated array: ${body.slice(0, 40)}`);

  const out: TomlValue[] = [];
  let buf = "";
  let depth = 0;
  let inBasic = false;
  let inLiteral = false;

  const flush = (): void => {
    const item = stripComment(buf).trim();
    buf = "";
    if (item) out.push(parseValue(item, false));
  };

  for (let i = 1; i < close; i++) {
    const ch = body[i] as string;
    if (inBasic) {
      buf += ch;
      if (ch === "\\") {
        buf += body[i + 1] ?? "";
        i++;
      } else if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      buf += ch;
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
      buf += ch;
    } else if (ch === "'") {
      inLiteral = true;
      buf += ch;
    } else if (ch === "[") {
      depth++;
      buf += ch;
    } else if (ch === "]") {
      depth--;
      buf += ch;
    } else if (ch === "," && depth === 0) {
      flush();
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}
