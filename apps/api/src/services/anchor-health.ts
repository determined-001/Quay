import { Keypair } from "@stellar/stellar-sdk";
import { NOOP_LOGGER, type Logger } from "@checkout/core";
import { endpointUrl, fetchStellarToml, type AnchorDiscovery } from "@checkout/offramp";

// ---------------------------------------------------------------------------
// AnchorHealth — background probe + circuit breaker (issue #19, 3.7).
// ---------------------------------------------------------------------------
// A live `AnchorHealth` distinguishes a dead anchor from a slow one. A
// background timer pings TOML + SEP-10 + /info every `intervalMs`. After
// `failureThreshold` consecutive failures the breaker opens; while open,
// `triggerCashOut` fails fast with 503 "anchor_unavailable" instead of
// hammering a dead endpoint. After `cooldownMs` the breaker transitions to
// `half_open` and the very next probe decides whether we go back to `closed`
// (success) or stay `open` (another failure).
//
// One instance guards one anchor. `AnchorHealthRegistry` (below) keys them by
// anchor home domain so one dead anchor cannot pause cash-outs at the others
// (issue 3.23).

export type CircuitState = "closed" | "open" | "half_open";

/**
 * SEP-10 liveness result. `"skipped"` means the probe asked for a challenge
 * with a generated, unfunded account and the anchor declined it — that says
 * nothing about the anchor's health, so it is neither a pass nor a failure.
 */
export type Sep10Probe = boolean | "skipped";

export interface AnchorHealthSnapshot {
  /** Anchor home domain this breaker guards. */
  domain: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  url: string | null;
  probes: { toml: boolean; sep10: Sep10Probe; info: boolean };
}

export interface AnchorProbeConfig {
  /** When false (mock mode), `probe()` short-circuits to a success without any network IO. */
  enabled: boolean;
  /** Anchor base URL (e.g. https://testanchor.stellar.org). */
  url?: string | null;
  /** Home domain used for TOML and SEP-10. */
  homeDomain: string | null;
  /**
   * SEP-1 discovery for this anchor. When present the probe uses the endpoints
   * the anchor actually published (WEB_AUTH_ENDPOINT, TRANSFER_SERVER) instead
   * of guessing paths, and re-reads the TOML so a rotated SIGNING_KEY is picked
   * up without a restart (issue 3.23).
   */
  discovery?: AnchorDiscovery;
  /**
   * Account the SEP-10 liveness probe asks for a challenge for. When null the
   * probe generates a fresh random public key per tick: most anchors only need
   * a syntactically valid account, and one that rejects an unfunded account is
   * reported as `sep10: "skipped"` rather than faked as a pass.
   */
  probeAccount?: string | null;
  /** Defaults to 3. */
  failureThreshold?: number;
  /** Defaults to 30_000 ms. */
  cooldownMs?: number;
  /** Defaults to 5_000 ms per individual probe HTTP call. */
  requestTimeoutMs?: number;
  logger?: Logger;
}

export class AnchorHealth {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastCheckedAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private probes: { toml: boolean; sep10: Sep10Probe; info: boolean } = {
    toml: false,
    sep10: false,
    info: false,
  };

  private readonly enabled: boolean;
  private readonly url: string | null;
  private readonly homeDomain: string | null;
  private readonly discovery: AnchorDiscovery | undefined;
  private readonly probeAccount: string | null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;

  constructor(cfg: AnchorProbeConfig) {
    this.enabled = cfg.enabled;
    this.url = cfg.url ?? null;
    this.homeDomain = cfg.homeDomain;
    this.discovery = cfg.discovery;
    this.probeAccount = cfg.probeAccount ?? null;
    this.failureThreshold = cfg.failureThreshold ?? 3;
    this.cooldownMs = cfg.cooldownMs ?? 30_000;
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? 5_000;
    this.logger = cfg.logger ?? NOOP_LOGGER;
  }

  /** The anchor this breaker guards, used as the registry key. */
  get domain(): string {
    return this.homeDomain ?? this.discovery?.homeDomain ?? this.url ?? "unknown";
  }

  /**
   * Snapshot of the current breaker state. The returned `state` reflects the
   * promotion (open → half_open on cooldown expiry) — see `tickState` for the
   * explicit time-advance mutation this triggers.
   */
  snapshot(): AnchorHealthSnapshot {
    this.tickState();
    return {
      domain: this.domain,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.lastCheckedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      url: this.url,
      probes: { ...this.probes },
    };
  }

  /**
   * `true` when cash-out traffic is allowed. `closed` and `half_open` are both
   * "try it"; only `open` (within the cooldown window) blocks traffic. This
   * method mutates the stored state on cooldown expiry so callers always see
   * the most recent decision; the side-effect is explicit in `tickState`.
   */
  isAvailable(): boolean {
    this.tickState();
    return this.state !== "open";
  }

  /**
   * Time-based advance of the breaker. Promotes `open → half_open` once the
   * cooldown has elapsed, so the next probe becomes a "trial shot". Exposed as
   * a public helper so callers can be explicit about the mutation if they
   * want to; we still call it from getters in this file because that's the
   * sanest policy for snap/decide ergonomics.
   */
  tickState(): void {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.cooldownMs
    ) {
      this.state = "half_open";
    }
  }

  /** Run one probe cycle: TOML → SEP-10 challenge → /info. */
  async probe(): Promise<AnchorHealthSnapshot> {
    const homeDomain = this.homeDomain ?? this.discovery?.homeDomain ?? null;
    if (!this.enabled || !homeDomain) {
      // Mock mode or unconfigured: short-circuit to a healthy state without IO.
      this.tickState();
      this.recordSuccess();
      return this.snapshot();
    }
    // Time-advance before we measure: if the cooldown just elapsed, we want
    // this probe to count as the half-open trial shot rather than get blocked
    // by an out-of-date "open" state.
    this.tickState();
    this.lastCheckedAt = Date.now();
    const probes: { toml: boolean; sep10: Sep10Probe; info: boolean } = {
      toml: false,
      sep10: false,
      info: false,
    };
    try {
      let webAuthEndpoint: string;
      let transferServer: string;

      if (this.discovery) {
        // 1. TOML reachable, and the endpoints the adapter will actually call.
        // Forced so a rotated SIGNING_KEY is seen even while the SEP-1 cache
        // is still warm.
        const toml = await fetchStellarToml(homeDomain, { force: true, logger: this.logger });
        probes.toml = !toml.fallback;
        if (toml.fallback) throw new Error("TOML probe could not read stellar.toml");
        webAuthEndpoint = toml.webAuthEndpoint;
        transferServer = toml.transferServer;

        // A rotated SIGNING_KEY would otherwise stay cached for the life of the
        // process: every seller's challenge() would fail verification until a
        // restart. Drop the cache and let the next call re-read the TOML.
        const cached = await this.discovery.get();
        if (cached.signingKey && toml.signingKey && cached.signingKey !== toml.signingKey) {
          this.discovery.invalidate();
          this.logger.warn(
            { event: "anchor.signing_key.changed", homeDomain },
            "anchor rotated its SIGNING_KEY; invalidated cached SEP-1 discovery",
          );
        }
      } else {
        const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
        const tomlRes = await fetchWithTimeout(tomlUrl, this.requestTimeoutMs);
        probes.toml = tomlRes.ok;
        if (!tomlRes.ok) throw new Error(`TOML probe returned ${tomlRes.status}`);
        const base = this.url ?? `https://${homeDomain}`;
        webAuthEndpoint = new URL("/auth", base).toString();
        transferServer = endpointUrl(base, "sep6").toString();
      }

      // 2. SEP-10 challenge obtainable (no signing — this is a liveness check).
      const account = this.probeAccount ?? Keypair.random().publicKey();
      const sep10Url = new URL(webAuthEndpoint);
      sep10Url.searchParams.set("account", account);
      sep10Url.searchParams.set("home_domain", homeDomain);
      const sep10Res = await fetchWithTimeout(sep10Url.toString(), this.requestTimeoutMs);
      if (sep10Res.ok) {
        const sep10Body = (await sep10Res.json()) as { transaction?: string };
        if (!sep10Body.transaction) throw new Error("SEP-10 challenge missing transaction");
        probes.sep10 = true;
      } else if (!this.probeAccount) {
        // No configured account: an anchor may reject an unfunded one. That is
        // not an outage, so record it honestly instead of faking a pass.
        probes.sep10 = "skipped";
      } else {
        throw new Error(`SEP-10 challenge returned ${sep10Res.status}`);
      }

      // 3. /info 200 on the transfer server the adapter uses: a probe that
      // checks an endpoint the product never calls tells you nothing when it
      // passes and lies when it fails.
      const infoUrl = endpointUrl(transferServer, "info");
      const infoRes = await fetchWithTimeout(infoUrl.toString(), this.requestTimeoutMs);
      probes.info = infoRes.ok;
      if (!infoRes.ok) throw new Error(`/info returned ${infoRes.status}`);

      this.probes = probes;
      this.recordSuccess();
    } catch (err) {
      this.probes = probes;
      this.recordFailure(err);
    }
    return this.snapshot();
  }

  private recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

/** An empty, healthy snapshot for a registry with no anchors configured. */
function emptySnapshot(domain: string | undefined): AnchorHealthSnapshot {
  return {
    domain: domain ?? "none",
    state: "closed",
    consecutiveFailures: 0,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: null,
    url: null,
    probes: { toml: false, sep10: false, info: false },
  };
}

export interface AnchorHealthEntry {
  domain: string;
  health: AnchorHealth;
}

/**
 * Health and breaker state, keyed by anchor home domain (issue 3.23). With one
 * anchor this is a thin map; with several it is what keeps one dead anchor from
 * pausing cash-outs at the rest. Callers ask for the anchor they are about to
 * use by domain, or fall back to the only/first entry.
 */
export class AnchorHealthRegistry {
  private readonly byDomain = new Map<string, AnchorHealth>();

  constructor(entries: AnchorHealthEntry[] = []) {
    for (const entry of entries) this.register(entry.domain, entry.health);
  }

  register(domain: string, health: AnchorHealth): void {
    this.byDomain.set(domain, health);
  }

  /** The health for `domain`, or the first registered anchor when omitted/unknown. */
  get(domain?: string): AnchorHealth | undefined {
    if (domain !== undefined) {
      const exact = this.byDomain.get(domain);
      if (exact) return exact;
    }
    return this.byDomain.values().next().value;
  }

  isAvailable(domain?: string): boolean {
    const health = this.get(domain);
    return health ? health.isAvailable() : true;
  }

  snapshot(domain?: string): AnchorHealthSnapshot {
    return this.get(domain)?.snapshot() ?? emptySnapshot(domain);
  }

  snapshots(): AnchorHealthSnapshot[] {
    return [...this.byDomain.values()].map((health) => health.snapshot());
  }

  domains(): string[] {
    return [...this.byDomain.keys()];
  }

  get size(): number {
    return this.byDomain.size;
  }

  async probeAll(): Promise<AnchorHealthSnapshot[]> {
    return Promise.all([...this.byDomain.values()].map((health) => health.probe()));
  }
}
