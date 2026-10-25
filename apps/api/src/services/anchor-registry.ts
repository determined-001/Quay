import type { AnchorCustomer, KycPort, Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import type { AnchorDiscovery, SellerAnchorAuth } from "@checkout/offramp";
import type { AnchorHealth } from "./anchor-health";
import type { CircuitBreakerOffRamp } from "./circuit-breaker";
import type { AnchorRoute, AnchorRouter } from "./link-service";

/**
 * Anchors the deployment can cash out through (issue 3.21).
 *
 * One row per anchor, in the `anchors` table. Nothing secret lives here: an
 * anchor is a public domain plus how Quay should talk to it. Authority over an
 * anchor belongs to each seller's own SEP-10 session, never to a credential in
 * this table.
 */
export type AnchorProtocol = "auto" | "sep6" | "sep24";

export interface AnchorRecord {
  id: string;
  /** The anchor's SEP-1 home domain; unique. */
  homeDomain: string;
  /** Origin the guessed endpoint layout hangs off when SEP-1 discovery fails. */
  baseUrl: string;
  displayName: string;
  /** A disabled anchor takes no new cash-outs but still polls the jobs it already has. */
  enabled: boolean;
  protocol: AnchorProtocol;
  /** Preferred SEP-6 withdrawal type (`OFFRAMP_TYPE`'s per-anchor home). */
  withdrawType: string | null;
  /** Target currencies this anchor serves. Empty means "any" (what an env-seeded row has). */
  corridors: string[];
  /** FX rate source kind (`sep38 | static | http`); its parameters stay environment-wide. */
  rateSource: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AnchorRepository {
  /** Every anchor, oldest first. */
  list(): Promise<AnchorRecord[]>;
  insert(record: AnchorRecord): Promise<void>;
  /** False when no such anchor exists. */
  setEnabled(homeDomain: string, enabled: boolean, now?: number): Promise<boolean>;
}

/** Everything the deployment holds for one anchor, built once and reused. */
export interface AnchorEntry extends AnchorRoute {
  record: AnchorRecord;
  discovery: AnchorDiscovery;
  auth: SellerAnchorAuth;
  offramp: CircuitBreakerOffRamp;
  kyc: KycPort;
  health: AnchorHealth;
}

export interface AnchorRegistryOptions {
  repo: AnchorRepository;
  /** Builds the adapters for one anchor. May throw on a misconfiguration (it is logged, and the anchor is skipped). */
  build: (record: AnchorRecord) => Promise<Omit<AnchorEntry, "record" | "domain">>;
  /** The anchor `OFFRAMP`-era env config named; preferred as the default when it is enabled. */
  preferredDomain?: string;
  /** How long the anchors table is trusted before it is read again. */
  ttlMs?: number;
  logger?: Logger;
  now?: () => number;
}

const SEP24_MARKER = "#sep24";

/** `offramp_jobs.anchor` is the home domain, plus `#sep24` for a SEP-24 job. */
export function anchorDomainOfJob(label: string): string {
  return label.endsWith(SEP24_MARKER) ? label.slice(0, -SEP24_MARKER.length) : label;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Lazily builds and caches, per anchor, the discovery, seller auth, KYC and
 * circuit-broken off-ramp adapter, and answers "which anchor?" for a cash-out
 * (by corridor) or a poll (by the job's stored anchor).
 *
 * The table is re-read every `ttlMs`, so an operator adding or disabling an
 * anchor with `scripts/anchors.mjs` takes effect without a redeploy. An anchor
 * whose row changed is rebuilt; its circuit-breaker state starts fresh.
 */
export class AnchorRegistry implements AnchorRouter {
  private readonly repo: AnchorRepository;
  private readonly buildParts: AnchorRegistryOptions["build"];
  private readonly preferredDomain: string | undefined;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  private records: AnchorRecord[] = [];
  private loadedAt = Number.NEGATIVE_INFINITY;
  private readonly entries = new Map<string, { updatedAt: number; entry: Promise<AnchorEntry> }>();

  constructor(opts: AnchorRegistryOptions) {
    this.repo = opts.repo;
    this.buildParts = opts.build;
    this.preferredDomain = opts.preferredDomain;
    this.ttlMs = opts.ttlMs ?? 10_000;
    this.logger = (opts.logger ?? NOOP_LOGGER).child({ component: "anchor-registry" });
    this.now = opts.now ?? Date.now;
  }

  private async load(force = false): Promise<AnchorRecord[]> {
    if (force || this.now() - this.loadedAt >= this.ttlMs) {
      this.records = await this.repo.list();
      this.loadedAt = this.now();
    }
    return this.records;
  }

  /** Re-read the anchors table on the next call. */
  invalidate(): void {
    this.loadedAt = Number.NEGATIVE_INFINITY;
  }

  async list(): Promise<AnchorRecord[]> {
    return [...(await this.load())];
  }

  async enabled(): Promise<AnchorRecord[]> {
    return (await this.load()).filter((r) => r.enabled);
  }

  private build(record: AnchorRecord): Promise<AnchorEntry> {
    const cached = this.entries.get(record.id);
    if (cached && cached.updatedAt === record.updatedAt) return cached.entry;
    const entry = this.buildParts(record).then((parts) => ({ ...parts, record, domain: record.homeDomain }));
    this.entries.set(record.id, { updatedAt: record.updatedAt, entry });
    // A failed build is not cached: the next call retries (the row may have been fixed).
    entry.catch(() => {
      if (this.entries.get(record.id)?.entry === entry) this.entries.delete(record.id);
    });
    return entry;
  }

  private async safe(record: AnchorRecord): Promise<AnchorEntry | null> {
    try {
      return await this.build(record);
    } catch (err) {
      this.logger.error(
        { event: "anchor.build_failed", anchor: record.homeDomain, error: err instanceof Error ? err.message : String(err) },
        "could not build the adapters for an anchor; it is unavailable until its configuration is fixed",
      );
      return null;
    }
  }

  /**
   * Builds every enabled anchor now. Strict: a misconfigured anchor throws, so
   * a bad deployment fails at boot rather than mid-cash-out.
   */
  async warm(): Promise<AnchorEntry[]> {
    const records = await this.load(true);
    return Promise.all(records.filter((r) => r.enabled).map((r) => this.build(r)));
  }

  /** The built entry for a home domain (enabled or not), or null. */
  async byDomain(homeDomain: string): Promise<AnchorEntry | null> {
    const record = (await this.load()).find((r) => same(r.homeDomain, homeDomain));
    return record ? this.safe(record) : null;
  }

  /**
   * The enabled anchor serving `targetCurrency`: one that names it among its
   * corridors wins; otherwise the oldest enabled anchor with no corridors listed
   * ("any"). Null when none does.
   */
  async forCurrency(targetCurrency: string): Promise<AnchorEntry | null> {
    const enabled = await this.enabled();
    const wanted = targetCurrency.toUpperCase();
    const record =
      enabled.find((r) => r.corridors.some((c) => c.toUpperCase() === wanted)) ??
      enabled.find((r) => r.corridors.length === 0);
    return record ? this.safe(record) : null;
  }

  /**
   * The anchor that owns a stored job. Disabled anchors are included: disabling
   * stops new cash-outs, it does not strand withdrawals already in flight.
   * An unknown label (a legacy row) is null, and the caller falls back.
   */
  async forJob(anchorLabel: string): Promise<AnchorEntry | null> {
    return this.byDomain(anchorDomainOfJob(anchorLabel));
  }

  /** The default anchor: the preferred one if enabled, else the oldest enabled one. */
  async fallback(): Promise<AnchorEntry | null> {
    const enabled = await this.enabled();
    const record =
      (this.preferredDomain ? enabled.find((r) => same(r.homeDomain, this.preferredDomain!)) : undefined) ?? enabled[0];
    return record ? this.safe(record) : null;
  }

  /** The live-session check the poller needs, resolved against the job's own anchor. */
  async hasLiveSession(customer: AnchorCustomer, anchorLabel: string | undefined): Promise<boolean> {
    const entry = anchorLabel ? await this.forJob(anchorLabel) : null;
    const target = entry ?? (await this.fallback());
    if (!target) return false;
    return (await target.auth.sessionExpiry(customer)) !== null;
  }
}


export interface AnchorSeedConfig {
  /** `OFFRAMP`: only `testanchor` and `anchor` have an anchor to seed. */
  offramp: string;
  homeDomain: string;
  baseUrl: string;
  protocol: AnchorProtocol;
  withdrawType: string | undefined;
  rateSource: string | undefined;
}

/**
 * First boot of a deployment that predates the `anchors` table: if it is empty
 * and `OFFRAMP` names a real anchor, insert one row from the environment so the
 * deployment keeps working unchanged. Returns the inserted record, or null when
 * nothing was seeded. After this the table is the source of truth: editing the
 * env vars again does not change an existing row (use `scripts/anchors.mjs`).
 */
export async function seedAnchorsFromEnv(
  repo: AnchorRepository,
  cfg: AnchorSeedConfig,
  newId: () => string,
  now: number = Date.now(),
): Promise<AnchorRecord | null> {
  if (cfg.offramp !== "testanchor" && cfg.offramp !== "anchor") return null;
  if ((await repo.list()).length > 0) return null;
  const record: AnchorRecord = {
    id: newId(),
    homeDomain: cfg.homeDomain,
    baseUrl: cfg.baseUrl,
    displayName: cfg.homeDomain,
    enabled: true,
    protocol: cfg.protocol,
    withdrawType: cfg.withdrawType ?? null,
    corridors: [], // any currency: what a single-anchor deployment always did
    rateSource: cfg.rateSource ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await repo.insert(record);
  return record;
}
