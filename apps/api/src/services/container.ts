import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  resolveStellarConfig,
  StellarRail,
  HorizonWatcher,
  StreamingHorizonWatcher,
  type HorizonStatus,
} from "@checkout/stellar";
import {
  AnchorDiscovery,
  AnchorOffRamp,
  DisabledOffRamp,
  MockAnchorOffRamp,
  NoKycRequired,
  SelectingOffRamp,
  SellerAnchorAuth,
  TESTANCHOR_BASE_URL,
  TESTANCHOR_HOME_DOMAIN,
  TestAnchorKyc,
  deleteSep12Customer,
  requireKycServer,
  TestAnchorOffRamp,
} from "@checkout/offramp";
import type {
  KycPort,
  AnchorCustomer,
  Logger,
  OffRampPort,
  OffRampStateRepository,
  OffRampTelemetryRepository,
  RailPort,
  RateSourcePort,
  PrefillConsentRepository,
  SellerProfileRepository,
  WebhookRepository,
} from "@checkout/core";
import { KycConsentRepository } from "@checkout/core";
import { env } from "../env";
import { createDb, bootstrap, type DB } from "../db/client";
import { parsePiiKey, parsePiiKeyring } from "../crypto/pii";
import { metrics } from "../metrics";
import { createLogger } from "../logger";
import { WebhookSender } from "./webhook-sender";
import { KycEvents } from "./kyc-events";
import { createClientDomainSigner } from "./client-domain-signer";
import {
  DrizzleLinkRepository,
  DrizzleSellerRepository,
  DrizzleWebhookRepository,
  DrizzleWatcherStateRepository,
  DrizzleTokenRevocationRepository,
  DrizzleOffRampStateRepository,
  DrizzleKycRepository,
  DrizzleOfframpTelemetryRepository,
  DrizzleApiKeyRepository,
  DrizzleAnchorSessionRepository,
  ANCHOR_SESSION_SWEEP_GRACE_MS,
  DrizzleAnchorRepository,
  DrizzleKycConsentRepository,
  DrizzlePrefillConsentRepository,
  DrizzleSellerProfileRepository,
} from "../repos/index";
import { LinkService } from "./link-service";
import { AnchorHealth, AnchorHealthRegistry } from "./anchor-health";
import {
  WatcherLoop,
  startCashOutPoller,
  startAnchorProbeTimer,
  type AccountCircuitBreakerStatus,
  type WatcherMetrics,
} from "../worker/watcher-loop";
import { ChallengeService } from "./challenge";
import { RedisUsedChallengeStore } from "./redis-used-challenge-store";
import { keypairFromSecret, resolveSellerKeypairOrWallet } from "./seller-wallet";
import { horizonSignerFetcher } from "./horizon-signers";
import { SessionIssuer } from "./session";
import type { StellarTomlConfig } from "../routes/well-known";
import { CircuitBreakerOffRamp } from "./circuit-breaker";
import { WebhookWorker } from "../worker/webhook-worker";
import { assertKeyConfigured } from "./secret-crypto";
import { createRateSource } from "./rate-source";
import { guardWebhookUrl } from "./ssrf-guard";
import { runKycRetentionSweep } from "./kyc-retention";
import { AnchorRegistry, seedAnchorsFromEnv, type AnchorRecord } from "./anchor-registry";
import { newId } from "./ids";
import { PiiAuditService, runPiiAuditSweep, type PiiAuditRecorder } from "./pii-audit";

/** `pii_audit.actor_id` for reads of the seller's stored values to pre-fill an anchor's SEP-24 form. */
const SEP24_PREFILL_ACTOR = "sep24-prefill";

export interface Container {
  service: LinkService;
  logger: Logger;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  apiKeys: DrizzleApiKeyRepository;
  db: DB;
  kyc: KycPort;
  /** Per-anchor KYC consent repository. */
  kycConsents: KycConsentRepository;
  /** Fields a seller agreed to share with an anchor to pre-fill its SEP-24 form (issue 3.17). Optional so partial test containers stay valid. */
  prefillConsents?: PrefillConsentRepository;
  /** The seller's reusable SEP-9 profile (issue 4.23). Null unless a real anchor and
   *  KYC_ENCRYPTION_KEY are configured, since values are encrypted with that key. */
  sellerProfile?: SellerProfileRepository | null;
  /** The anchor's home domain (e.g. "testanchor.stellar.org") for consent tracking. Null when no real anchor. */
  anchorDomain: string | null;
  kycRepo?: DrizzleKycRepository | null;
  /** Audit log of access to seller identity data (issue 8.15). Optional so partial test containers stay valid. */
  piiAudit?: PiiAuditService;
  /** Sellers' own SEP-10 sessions with the anchor. Null when there is no real
   *  anchor (OFFRAMP=mock|none), so nothing to sign in to. */
  anchorAuth: SellerAnchorAuth | null;
  /** The anchors the deployment can cash out through (issue 3.21). Null for mock / none. */
  anchors?: AnchorRegistry | null;
  /** Home domains of every registered anchor (enabled or not), for erasure across all of them. */
  anchorDomains?: () => Promise<string[]>;
  anchorSessions?: DrizzleAnchorSessionRepository | null;
  /** Asks one anchor (the default when `anchorDomain` is omitted) to erase the seller's SEP-12 customer. */
  deleteAnchorCustomer?: ((customer: AnchorCustomer, anchorDomain?: string) => Promise<"deleted" | "not_found">) | null;
  telemetry: OffRampTelemetryRepository;
  config: { network: string; horizonUrl: string; sellerWallet: string | null; kycStatusCacheMs?: number };
  horizonStatus(): HorizonStatus;
  /** Optional SSRF guard override for webhook URLs. Tests inject a permissive
   *  one so route tests do not depend on live DNS. */
  webhookGuard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  metricsToken: string;
  /** Whether settlements are being attested on-chain, and to which registry.
   *  Surfaced on /health so "the contract is deployed" and "the product calls
   *  it" can be told apart from outside, without an account or a log tail. */
  watcherLagSeconds(): number;
  circuitBreakerState(): number;
  auth: {
    challenge: ChallengeService;
    session: SessionIssuer;
    stellarToml: StellarTomlConfig;
    revocations: DrizzleTokenRevocationRepository;
    secureCookie: boolean;
    /** CORS_ORIGINS, reused as the CSRF allowlist for cookie-authenticated
     *  state changes (middleware/auth.ts). */
    allowedOrigins: string[];
  };
  start(): void;
  stop(): void | Promise<void>;
  /** Readiness probe: can this instance actually serve traffic right now (i.e. is the database reachable)? Distinct from liveness (`/health`) - a process can be alive but not yet/no-longer able to serve. */
  ready(): Promise<boolean>;
  getWatcherCircuitBreakerStatus(): AccountCircuitBreakerStatus[];
  getWatcherMetrics(): WatcherMetrics;
}

export async function createContainer(): Promise<Container> {
  // Root pino logger is the single source. The request-context middleware
  // builds child loggers bound to requestId/method/path and routes pass
  // those children explicitly into service calls — so deep subsystems
  // (LinkService, off-ramp adapters, webhook sender) inherit requestId
  // without us needing any ambient / AsyncLocalStorage plumbing.
  const logger = createLogger({ level: env.logLevel, base: { network: env.network } });

  assertSharedStateOrSingleInstance(env, logger);

  // Resolve the webhook-secret encryption key NOW rather than lazily on the
  // first encrypt/decrypt. `secret-crypto.ts` throws when the key is missing in
  // production — but it is only reached when a seller first registers a
  // webhook, so a misconfigured deploy boots green and fails on a customer's
  // request hours later. Touching it here turns that into a boot failure the
  // deploy itself surfaces.
  assertKeyConfigured();

  const stellar = resolveStellarConfig({
    network: env.network,
    horizonUrl: env.horizonUrl,
    usdcIssuer: env.usdcIssuer,
  });

  const { db, client } = createDb(env.databaseUrl, env.databaseAuthToken);
  // A real anchor's home domain attributes pre-4.24 seller_kyc rows to it; with
  // none configured they stay "legacy" and are never reused for a customer id.
  await bootstrap(client, db, {
    kycAnchorDomain:
      env.offramp === "testanchor" || env.offramp === "anchor"
        ? env.anchorHomeDomain ?? TESTANCHOR_HOME_DOMAIN
        : null,
  });

  const piiKey = env.kycEncryptionKey ? parsePiiKey(env.kycEncryptionKey) : null;
  if (!piiKey) {
    logger.info(
      { event: "seller.payout_fields.reuse_disabled" },
      "KYC_ENCRYPTION_KEY not set; seller payout field reuse is disabled",
    );
  }

  const linksRepo = new DrizzleLinkRepository(db);
  const sellersRepo = new DrizzleSellerRepository(db, piiKey, logger);
  await sellersRepo.backfillLegacyPayoutFields();
  const webhooksRepo = new DrizzleWebhookRepository(db);
  const stateRepo = new DrizzleWatcherStateRepository(db);
  const revocationsRepo = new DrizzleTokenRevocationRepository(db);
  const offrampStateRepo = new DrizzleOffRampStateRepository(db);
  const telemetryRepo = new DrizzleOfframpTelemetryRepository(db);
  const apiKeysRepo = new DrizzleApiKeyRepository(db);
  const anchorSessionsRepo = new DrizzleAnchorSessionRepository(db, logger);
  const kycConsentsRepo = new DrizzleKycConsentRepository(db);
  const prefillConsentsRepo = new DrizzlePrefillConsentRepository(db);
  const kycKeyring = env.kycEncryptionKey
    ? parsePiiKeyring(env.kycEncryptionKey, env.kycEncryptionKeyPrevious)
    : null;
  const piiAuditService = new PiiAuditService(db, logger);
  const kycRepo = kycKeyring ? new DrizzleKycRepository(db, kycKeyring) : null;

  // Optional. Quay is multi-tenant: a seller signs in with their own wallet
  // over SEP-10, that address becomes their identity AND their payout
  // destination, and `POST /links` sets `destination: seller.wallet` from the
  // authenticated seller — never from configuration. So there is no wallet
  // this deployment needs to own, and requiring one implied a custody
  // relationship that does not exist.
  //
  // What it still buys, when set, is a convenience: `/health` can report
  // whether ONE known wallet holds a USDC trustline, and testnet gets a
  // throwaway seller so `pnpm dev` works with no configuration. Neither is a
  // correctness guarantee — that lives in `assertCanReceive`, which runs per
  // seller on every single link creation and 422s with a trustline URI.
  const seller = resolveSellerKeypairOrWallet(logger);
  const sellerWallet = seller.publicKey;
  if (sellerWallet) await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  const realRail = new StellarRail(stellar);
  // E2E test mode runs with no network at all (issue 5.7): keep the pure
  // parts of the rail (SEP-7 building, address validation) and skip only the
  // Horizon account/trustline preflight. The preflight's own behavior is
  // covered by unit tests; env.ts guarantees this branch cannot be reached
  // in production or on the public network.
  const rail: RailPort = env.e2eTestMode
    ? {
        buildRequest: (input) => realRail.buildRequest(input),
        isValidDestination: (address) => realRail.isValidDestination(address),
        assertCanReceive: async () => {},
      }
    : realRail;
  // Polling watcher gets the retry / fallback / degraded-tracking wrapper
  // (issue #10). The streaming path has its own reconnect handling.
  const pollingWatcher = new HorizonWatcher({
    primaryServer: stellar.horizonUrl,
    fallbackServer: env.horizonUrlFallback,
    degradedThreshold: env.horizonDegradedThreshold,
    log: (m) => console.log(`[horizon] ${m}`),
  });
  const watcher =
    env.watchMode === "stream"
      ? new StreamingHorizonWatcher(stellar.horizonUrl, { log: (m) => console.log(`[watcher:stream] ${m}`) })
      : pollingWatcher;
  // The platform's stable SEP-10 identity: the key wallets authenticate
  // against and the SIGNING_KEY advertised in stellar.toml. Resolved before the
  // anchor wiring so the SEP-10 client_domain co-signer can be built from it.
  const serverKeypair = resolveServerSigningKeypair();
  const realAnchors = env.offramp === "testanchor" || env.offramp === "anchor";
  const webhookSender = new WebhookSender(webhooksRepo, { maxAttempts: 1, logger });
  // Anchor health probe + circuit breaker (issue #19, 3.7; per-anchor registry
  // issue 3.23). Empty for mock/none, where every anchor reads as available;
  // each real anchor registers its own probe when the registry builds it.
  const anchorHealth = new AnchorHealthRegistry();

  // Anchors (issue 3.21). A deployment that predates the table gets one row
  // seeded from the environment on its first boot, so it keeps working
  // unchanged; after that the table is the source of truth.
  const anchorsRepo = new DrizzleAnchorRepository(db);
  let anchorRegistry: AnchorRegistry | null = null;
  if (realAnchors) {
    const envDomain = env.anchorHomeDomain ?? TESTANCHOR_HOME_DOMAIN;
    const seeded = await seedAnchorsFromEnv(
      anchorsRepo,
      {
        offramp: env.offramp,
        homeDomain: envDomain,
        baseUrl: env.anchorUrl ?? TESTANCHOR_BASE_URL,
        protocol: env.offrampProtocol,
        withdrawType: env.offrampType,
        rateSource: env.offrampRateSource,
      },
      () => newId("anc"),
    );
    if (seeded) {
      logger.info({ event: "anchors.seeded", anchor: seeded.homeDomain }, "seeded the anchors table from the environment");
    } else {
      warnIfEnvAnchorDiverges(await anchorsRepo.list(), envDomain, logger);
    }
    anchorRegistry = new AnchorRegistry({
      repo: anchorsRepo,
      preferredDomain: envDomain,
      logger,
      build: async (record) => {
        const wiring = createAnchor(record, logger, stellar.networkPassphrase, serverKeypair, anchorSessionsRepo);
        // A misconfigured rate source fails the build: at boot that stops the process.
        const rateSource = await createRateSource({
          kind: record.rateSource ?? undefined,
          anchorDomain: record.homeDomain,
          offramp: env.offramp,
          ...(env.offrampRate ? { rate: env.offrampRate } : {}),
          ...(env.offrampRateExpiresAt ? { rateExpiresAt: env.offrampRateExpiresAt } : {}),
          ...(env.offrampRateCurrency ? { currency: env.offrampRateCurrency } : {}),
          ...(env.offrampRateSourceAsset ? { sourceAsset: env.offrampRateSourceAsset } : {}),
          ...(env.offrampRateUrl ? { url: env.offrampRateUrl } : {}),
          ...(env.offrampRateJsonPath ? { jsonPath: env.offrampRateJsonPath } : {}),
          // Same SSRF guard as seller-supplied webhook URLs: operator config is still
          // an outbound request to a hostname.
          guard: guardWebhookUrl,
          resolveQuoteServer: async () => (await wiring.discovery.get()).anchorQuoteServer ?? null,
        });
        const kyc = createKyc(wiring, kycRepo, sellersRepo, webhooksRepo, webhookSender, record.homeDomain, logger);
        const offramp = new CircuitBreakerOffRamp(
          createOffRamp(wiring, record, offrampStateRepo, logger, rateSource, {
            kycRepo,
            consents: prefillConsentsRepo,
            resolveType: (customer) => kyc.resolveType?.(customer) ?? Promise.resolve(null),
            audit: piiAuditService,
          }),
          { anchor: record.homeDomain },
        );
        const health = buildAnchorHealth(record, sellerWallet, wiring.discovery, logger);
        anchorHealth.register(record.homeDomain, health);
        return { discovery: wiring.discovery, auth: wiring.auth, offramp, kyc, health };
      },
    });
    // Strict: a misconfigured enabled anchor stops the boot rather than a cash-out.
    await anchorRegistry.warm();
  }
  const defaultAnchor = anchorRegistry ? await anchorRegistry.fallback() : null;

  // No anchors (mock / none), or none enabled: the single-adapter fields below
  // are never reached through the router; they keep today's mock / none behaviour.
  const offramp = defaultAnchor
    ? defaultAnchor.offramp
    : new CircuitBreakerOffRamp(createOffRamp(null, null, offrampStateRepo, logger, null, null), {});
  const kyc: KycPort = defaultAnchor ? defaultAnchor.kyc : new NoKycRequired();
  const sellerProfileRepo = await createSellerProfile(realAnchors, db, logger);
  const anchorDomain = defaultAnchor?.record.homeDomain ?? null;

  const service = new LinkService({
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    rail,
    offramp,
    offrampState: offrampStateRepo,
    kyc,
    stellar,
    operatorWallet: sellerWallet ?? undefined,
    telemetry: telemetryRepo,
    health: anchorHealth,
    anchorDomain: defaultAnchor?.record.homeDomain,
    ...(anchorRegistry ? { anchors: anchorRegistry } : {}),
    correlation: env.correlation,
    interactiveTimeoutMs: env.offrampInteractiveTimeoutMs,
    logger,
    // sessionExpiry is async: comparing the bare Promise to null was always true,
    // so the poller's pre-check never blocked on an expired session.
    hasLiveAnchorSession: anchorRegistry
      ? (customer, anchorLabel) => anchorRegistry.hasLiveSession(customer, anchorLabel)
      : undefined,
    piiAudit: piiAuditService,
  });

  // A link stuck in `offramp_pending` whose job has no row in offramp_jobs was
  // orphaned by a restart before this state was persisted (or, going forward,
  // a genuinely lost job). Recoverable state doesn't exist for it — fail it out
  // so the seller isn't stuck in silent limbo.
  const backfilled = await service.backfillLostOffRampJobs();
  if (backfilled > 0) {
    console.log(`[offramp] backfilled ${backfilled} link(s) stuck with lost job state -> offramp_failed`);
  }

  const loop = new WatcherLoop({
    watcher,
    links: linksRepo,
    state: stateRepo,
    service,
    pollMs: env.pollMs,
    logger,
    pageLimit: env.watchPageLimit,
    maxPagesPerTick: env.watchMaxPagesPerTick,
    log: (m) => console.log(`[watcher] ${m}`),
  });

  // The worker's own sender: it performs a single hardened attempt per tick and
  // leaves retry scheduling to the queue, so its maxAttempts is deliberately 1.
  const webhookWorker = new WebhookWorker(
    webhooksRepo,
    webhookSender,
    { log: (m) => console.log(`[webhook] ${m}`) },
  );
  const metricsToken = resolveMetricsToken();
  const challenge = new ChallengeService({
    serverKeypair,
    homeDomain: env.homeDomain,
    webAuthDomain: env.webAuthDomain,
    networkPassphrase: stellar.networkPassphrase,
    fetchAccountSigners: horizonSignerFetcher(stellar.horizonUrl),
    // Same REDIS_URL branch the rate limiter uses (index.ts) — without it,
    // "single-use" only holds per process (issue 6.7).
    usedChallengeStore: env.redisUrl ? new RedisUsedChallengeStore(env.redisUrl) : undefined,
  });
  const session = new SessionIssuer(resolveJwtSecret());
  const stellarToml: StellarTomlConfig = {
    signingKey: serverKeypair.publicKey(),
    webAuthEndpoint: `https://${env.webAuthDomain}/auth`,
    networkPassphrase: stellar.networkPassphrase,
    orgName: env.defaultSellerName,
  };

  let stopPoller: (() => void) | null = null;
  let stopRevocationSweep: (() => void) | null = null;
  let stopRetentionSweep: (() => void) | null = null;
  let stopAuditSweep: (() => void) | null = null;
  let stopProbe: (() => void) | null = null;

  return {
    service,
    logger,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    apiKeys: apiKeysRepo,
    db,
    kyc,
    kycConsents: kycConsentsRepo,
    prefillConsents: prefillConsentsRepo,
    sellerProfile: sellerProfileRepo,
    anchorDomain,
    kycRepo,
    piiAudit: piiAuditService,
    anchorAuth: defaultAnchor?.auth ?? null,
    anchors: anchorRegistry,
    anchorDomains: anchorRegistry ? async () => (await anchorRegistry.list()).map((r) => r.homeDomain) : undefined,
    anchorSessions: anchorSessionsRepo,
    deleteAnchorCustomer: anchorRegistry
      ? async (customer, domain) => {
          const entry = domain ? await anchorRegistry.byDomain(domain) : await anchorRegistry.fallback();
          if (!entry) throw new Error(`unknown anchor ${domain ?? "(default)"}`);
          const jwt = await entry.auth.token(customer);
          const kycServer = requireKycServer(await entry.discovery.get());
          return deleteSep12Customer(kycServer, jwt, customer.account);
        }
      : null,
    telemetry: telemetryRepo,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet, kycStatusCacheMs: env.kycStatusCacheMs },
    horizonStatus: () => pollingWatcher.getStatus(),
    metricsToken,
    watcherLagSeconds: () => loop.getLagSeconds(),
    circuitBreakerState: () => offramp.getStateNumeric(),
    auth: {
      challenge,
      session,
      stellarToml,
      revocations: revocationsRepo,
      secureCookie: env.cookieSecure,
      allowedOrigins: env.corsOrigins,
    },
    start() {
      if (env.e2eTestMode) {
        // The watcher is the one component that reaches out to Horizon on its
        // own; in e2e mode payments are injected through /__test__/pay at the
        // same applyMatch boundary, so the loop never starts and the process
        // makes no outbound calls. Everything downstream of a matched payment
        // (state machine, webhooks, mock off-ramp settlement) still runs.
        logger.warn({ event: "watcher.skipped.e2e" }, "E2E_TEST_MODE=1 - ledger watcher not started");
      } else {
        logger.info({ event: "watcher.start", pollMs: env.pollMs }, "watcher started");
        loop.start();
      }
      webhookWorker.start();
      // With no off-ramp there is nothing to advance: no link can reach
      // offramp_pending, so the poller would query an always-empty set on
      // every tick forever. The anchor probe is likewise pointless with no
      // anchor — buildAnchorHealth already disables it, and this skips the
      // timer that would only call a disabled probe.
      if (env.offramp !== "none") {
        stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs));
        stopProbe = startAnchorProbeTimer(anchorHealth, 60_000);
      }
      const sweepTimer = setInterval(() => {
        void revocationsRepo.sweepExpired(Math.floor(Date.now() / 1000));
        if (realAnchors) {
          void anchorSessionsRepo
            .sweepExpired(Date.now(), ANCHOR_SESSION_SWEEP_GRACE_MS)
            .then((count) => {
              if (count > 0) {
                logger.info({ event: "anchor.sessions.swept", count }, `swept ${count} expired anchor session(s)`);
              }
            })
            .catch((err) => {
              logger.warn({ event: "anchor.sessions.sweep_failed", err }, "failed to sweep expired anchor sessions");
            });
        }
      }, 60 * 60 * 1000); // hourly — revocation rows are cheap and self-limiting (max 24h lifetime) anyway
      stopRevocationSweep = () => clearInterval(sweepTimer);

      // Audit rows are kept for two years, then deleted. Runs daily and is not
      // configurable: shortening it would defeat the point of the log.
      const auditTimer = setInterval(() => {
        void runPiiAuditSweep({ db, logger }).catch((err) => {
          logger.error({ err }, "pii audit retention sweep error");
        });
      }, 24 * 60 * 60 * 1000);
      stopAuditSweep = () => clearInterval(auditTimer);

      if (env.kycRetentionDays > 0) {
        const sweepKyc = () => {
          void runKycRetentionSweep({
            db,
            retentionDays: env.kycRetentionDays,
            logger,
          }).catch((err) => {
            logger.error({ err }, "kyc retention sweep error");
          });
        };
        // Daily sweep interval (24 hours)
        const retentionTimer = setInterval(sweepKyc, 24 * 60 * 60 * 1000);
        stopRetentionSweep = () => clearInterval(retentionTimer);
      }
    },
    async stop() {
      await loop.stop();
      webhookWorker.stop();
      stopPoller?.();
      stopRevocationSweep?.();
      stopRetentionSweep?.();
      stopAuditSweep?.();
      if (watcher instanceof StreamingHorizonWatcher) watcher.stop();
      stopProbe?.();
      stopPoller = null;
      stopProbe = null;
      await client.close();
      console.log("[api] all services stopped");
    },
    getWatcherCircuitBreakerStatus() {
      return loop.getCircuitBreakerStatus();
    },
    getWatcherMetrics() {
      return loop.getMetrics();
    },
    async ready() {
      try {
        await client.execute("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * One anchor's health probe + circuit breaker. Defaults come from env (read
 * raw — we keep the surface minimal and don't pollute env.ts which lives
 * outside the scope of issue 3.7). Issue 3.23 keys the registry by home domain
 * so a second anchor gets its own breaker; the caller registers this one.
 */
function buildAnchorHealth(
  record: AnchorRecord,
  probeAccount: string | null,
  discovery: AnchorDiscovery,
  logger: Logger,
): AnchorHealth {
  const failureThreshold = Number(process.env.ANCHOR_PROBE_FAILURE_THRESHOLD ?? "3");
  const cooldownMs = Number(process.env.ANCHOR_PROBE_COOLDOWN_MS ?? "30000");
  return new AnchorHealth({
    enabled: true,
    url: record.baseUrl,
    homeDomain: record.homeDomain,
    // The configured seller wallet is a real, funded account, which is what the
    // anchor requires to issue a challenge. With no wallet configured the probe
    // generates one per tick and reports SEP-10 as "skipped" if declined.
    probeAccount,
    failureThreshold: Number.isFinite(failureThreshold) && failureThreshold > 0 ? failureThreshold : 3,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 30_000,
    discovery,
    logger,
  });
}

/**
 * The first boot after the `anchors` table exists is the only time the env
 * names an anchor to the table. If a later boot's env disagrees with the row,
 * say so once, so an operator editing `.env` is not left wondering why nothing
 * changed.
 */
function warnIfEnvAnchorDiverges(records: AnchorRecord[], envDomain: string, logger: Logger): void {
  const row = records.find((r) => r.homeDomain.toLowerCase() === envDomain.toLowerCase());
  if (!row) {
    logger.warn(
      { event: "anchors.env_anchor_unregistered", anchor: envDomain },
      "ANCHOR_HOME_DOMAIN names an anchor that is not in the anchors table; add it with scripts/anchors.mjs",
    );
    return;
  }
  const differs: string[] = [];
  if (row.protocol !== env.offrampProtocol) differs.push("OFFRAMP_PROTOCOL");
  if ((row.withdrawType ?? undefined) !== env.offrampType) differs.push("OFFRAMP_TYPE");
  if ((row.rateSource ?? undefined) !== env.offrampRateSource) differs.push("OFFRAMP_RATE_SOURCE");
  if (differs.length > 0) {
    logger.warn(
      { event: "anchors.env_ignored", anchor: row.homeDomain, settings: differs },
      "these env settings only seed the anchors table on first boot; the stored row is in force",
    );
  }
}

/**
 * Shared state, or a signed statement that there is only one process to share
 * it with.
 *
 * Without `REDIS_URL` the rate-limit counters and the SEP-10 single-use
 * challenge claim both live in an in-process `Map`. A second instance therefore
 * doubles every rate limit and makes one signed challenge redeemable once per
 * instance — a replay window that widens with each replica. Neither failure is
 * visible from outside the process, and scaling up is a dashboard slider that
 * touches no code, so the deploy that breaks this is the one nobody reviews.
 *
 * Refusing to boot turns it into a decision. `SINGLE_INSTANCE=true` is how an
 * operator states the decision they actually made.
 */
export function assertSharedStateOrSingleInstance(
  cfg: { network: string; redisUrl?: string; singleInstance: boolean },
  logger?: Logger,
): void {
  if (cfg.network !== "public" || cfg.redisUrl) return;
  if (!cfg.singleInstance) {
    throw new Error(
      "REDIS_URL is not set on the public network. Rate-limit counters and SEP-10 " +
        "challenge single-use claims are per-process without it, so N instances allow " +
        "N times every limit and N redemptions of one signed challenge. Either set " +
        "REDIS_URL, or set SINGLE_INSTANCE=true to state that this deployment runs " +
        "exactly one instance — and do not scale it up until REDIS_URL is set.",
    );
  }
  logger?.warn(
    { event: "scaling.single_instance" },
    "SINGLE_INSTANCE=true with no REDIS_URL — this deployment must stay at one instance",
  );
}


interface AnchorWiring {
  discovery: AnchorDiscovery;
  auth: SellerAnchorAuth;
}

/**
 * The anchor this deployment cashes out through, and the per-seller SEP-10
 * sessions with it. Null for `mock`/`none`, which have no anchor.
 *
 * There is no server keypair here. Every authenticated anchor call runs as the
 * seller whose wallet signed that anchor's challenge — so each seller is their
 * own customer at the anchor, and the server holds nothing that can sign for
 * a seller's funds.
 */
function createAnchor(
  record: AnchorRecord,
  logger: Logger,
  networkPassphrase: string,
  serverSigningKeypair: Keypair,
  sessions: DrizzleAnchorSessionRepository,
): AnchorWiring {
  const discovery = new AnchorDiscovery({
    homeDomain: record.homeDomain,
    fallbackBaseUrl: record.baseUrl,
    // SEP-1 discovery refuses an anchor declaring a different network, so a
    // mainnet deployment cannot quote against a testnet anchor by mistake.
    expectedNetworkPassphrase: networkPassphrase,
    logger,
  });
  // SEP-10 client_domain (issue 3.12): off by default. When on, the anchor is
  // asked for a client_domain op and Quay's SEP-10 identity co-signs it so the
  // anchor can attribute the seller. The signer holds Quay's login key, which
  // moves no funds; see client-domain-signer.ts.
  const clientDomain = env.anchorClientDomain
    ? {
        clientDomain: env.homeDomain,
        signClientDomain: createClientDomainSigner({
          keypair: serverSigningKeypair,
          networkPassphrase,
          clientDomain: env.homeDomain,
        }),
      }
    : {};
  const auth = new SellerAnchorAuth({
    discovery,
    networkPassphrase,
    sessions,
    logger,
    ...clientDomain,
  });
  return { discovery, auth };
}

/**
 * Both `testanchor` and `anchor` are the same SEP-6 adapter; they differ only
 * in whether the endpoint is the SDF sandbox or an operator-supplied
 * production anchor.
 */
function createOffRamp(
  anchor: AnchorWiring | null,
  record: AnchorRecord | null,
  state: OffRampStateRepository,
  logger: Logger,
  rateSource: RateSourcePort | null,
  prefill: {
    kycRepo: DrizzleKycRepository | null;
    consents: PrefillConsentRepository;
    resolveType: (customer: AnchorCustomer) => Promise<string | null>;
    audit: PiiAuditRecorder;
  } | null,
): OffRampPort {
  if (env.offramp === "none") {
    // No cash-out leg. Every method throws OffRampDisabledError, which the
    // routes translate to 501 — see packages/offramp/src/disabled.ts.
    return new DisabledOffRamp();
  }
  if (!anchor || !record || !prefill) {
    // Demo off-ramp: settles 8s after a seller triggers cash-out. NOT a real anchor.
    return new MockAnchorOffRamp({ state, settleAfterMs: 8000 });
  }
  // Present only when OFFRAMP_RATE_SOURCE is configured. With no rate source,
  // an anchor that declares no ANCHOR_QUOTE_SERVER refuses to quote rather
  // than being handed a made-up number.
  const rate = rateSource ? { rateSource } : {};
  const selecting = new SelectingOffRamp({
    discovery: anchor.discovery,
    protocol: record.protocol,
    sep6: new TestAnchorOffRamp({
      discovery: anchor.discovery,
      auth: anchor.auth,
      state,
      preferredWithdrawType: record.withdrawType ?? undefined,
      ...rate,
      logger,
    }),
    sep24: new AnchorOffRamp({
      discovery: anchor.discovery,
      auth: anchor.auth,
      state,
      ...rate,
      // SEP-24 form prefill needs the encrypted KYC store, i.e. KYC_ENCRYPTION_KEY (always set with a real anchor).
      ...(prefill.kycRepo
        ? {
            prefill: {
              kyc: prefill.kycRepo,
              consents: prefill.consents,
              resolveType: prefill.resolveType,
              audit: async (customer: AnchorCustomer, fields: readonly string[]) =>
                prefill.audit.record({
                  sellerId: customer.sellerId,
                  actorType: "system",
                  actorId: SEP24_PREFILL_ACTOR,
                  action: "kyc.read",
                  fields,
                }),
            },
          }
        : {}),
      logger,
    }),
    state,
    logger,
  });
  // Settle the protocol (and log `offramp.protocol`) now rather than on the
  // first cash-out. Never fatal and never awaited: an unreachable anchor must
  // not stop the API booting, and a misdeclared one is reported again, with the
  // declared list, on the first call that needs the protocol.
  selecting.protocol().catch((err: unknown) => {
    logger.warn(
      { event: "offramp.protocol.unresolved", error: err instanceof Error ? err.message : String(err) },
      "could not settle the off-ramp protocol at boot",
    );
  });
  return selecting;
}

/**
 * The seller's reusable SEP-9 profile (issue 4.23). Only exists when a real
 * anchor is configured, i.e. exactly when KYC_ENCRYPTION_KEY is guaranteed set
 * (see env.ts). On boot it lifts existing `seller_kyc` values into the profile
 * once; the migration is idempotent and logs counts, never values.
 */
async function createSellerProfile(
  hasAnchor: boolean,
  db: DB,
  logger: Logger,
): Promise<DrizzleSellerProfileRepository | null> {
  if (!hasAnchor) return null;
  const keyring = parsePiiKeyring(env.kycEncryptionKey as string, env.kycEncryptionKeyPrevious);
  const repo = new DrizzleSellerProfileRepository(db, keyring);
  const result = await repo.migrateFromSellerKyc();
  logger.info(
    { event: "seller_profile.migrated", ...result },
    `seller profile migration: ${result.migrated} field(s) from ${result.rows} seller_kyc row(s), ${result.failed} unreadable`,
  );
  return repo;
}

function createKyc(
  anchor: AnchorWiring,
  repo: DrizzleKycRepository | null,
  sellersRepo: DrizzleSellerRepository,
  webhooks: WebhookRepository | undefined,
  sender: WebhookSender | undefined,
  anchorDomain: string | undefined,
  logger: Logger,
): KycPort {
  if (!anchor || !repo) {
    // No real anchor, nothing to be compliant with. For "none" there is no
    // cash-out to gate at all; for "mock" it never gates the simulated one.
    return new NoKycRequired();
  }
  repo
    .countNonPrimaryRows()
    .then((count) => {
      metrics.kycNonPrimaryKeyRows.set(count);
    })
    .catch(() => {
      // ignore DB errors during initial metric probe if tables are not yet migrated
    });
  // Profile repository for reusable SEP-9 fields — uses the seller's payout fields
  const profileRepo = {
    async get(sellerId: string) {
      const seller = await sellersRepo.findById(sellerId);
      if (!seller || !seller.payoutFields) return null;
      return { fields: seller.payoutFields };
    },
  };
  // Public base URL of this API, used to register a SEP-12 push callback with the anchor.
  const callbackBaseUrl = env.homeDomain
    ? env.homeDomain.startsWith("http://") || env.homeDomain.startsWith("https://")
      ? env.homeDomain
      : `https://${env.homeDomain}`
    : undefined;
  const baseKyc = new TestAnchorKyc({
    discovery: anchor.discovery,
    auth: anchor.auth,
    repo,
    profileRepo,
    callbackBaseUrl,
    kycType: env.anchorKycType,
    kycTypeOrganization: env.anchorKycTypeOrganization,
    profileKindOf: async (sellerId) => (await sellersRepo.findById(sellerId))?.profileKind ?? null,
    logger,
  });
  if (webhooks && sender && anchorDomain) {
    return new KycEvents({
      inner: baseKyc,
      repo,
      webhooks,
      sender,
      anchorDomain,
    });
  }
  return baseKyc;
}

/**
 * Resolves the keypair that SIGNS SEP-10 challenges — the platform's own login
 * identity, distinct from any seller's wallet. Required to be stable
 * (SERVER_SIGNING_SECRET) on public network; auto-generates a throwaway testnet
 * keypair otherwise, same convenience as `resolveSellerKeypairOrWallet`.
 */
function resolveServerSigningKeypair(): Keypair {
  if (env.serverSigningSecret) return keypairFromSecret(env.serverSigningSecret, "SERVER_SIGNING_SECRET");
  if (env.network === "public") {
    throw new Error("Set SERVER_SIGNING_SECRET before running on public network (SEP-10 needs a stable signing key)");
  }
  const kp = Keypair.random();
  console.log(
    [
      "",
      "──────────────────────────────────────────────────────────────────",
      " No SERVER_SIGNING_SECRET set — generated a TESTNET SEP-10 signing keypair.",
      ` Signing key (in stellar.toml): ${kp.publicKey()}`,
      " Set SERVER_SIGNING_SECRET in .env to keep this stable across restarts —",
      " every restart otherwise invalidates in-flight sessions and stellar.toml.",
      "──────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  return kp;
}

/** Resolves the JWT session secret. Required on public network; auto-generates
 *  an ephemeral one on testnet (sessions won't survive a restart). */
function resolveJwtSecret(): string {
  if (env.jwtSecret) return env.jwtSecret;
  if (env.network === "public") {
    throw new Error("Set JWT_SECRET before running on public network (needed to mint stable sessions)");
  }
  console.log(" No JWT_SECRET set — generated an ephemeral testnet session secret (won't survive a restart).");
  return randomBytes(32).toString("hex");
}

/** Resolves the bearer token that gates `GET /metrics`. Auto-generates an
 *  ephemeral one (printed once at boot) if METRICS_TOKEN isn't set — the
 *  endpoint is always gated, never open by default. */
function resolveMetricsToken(): string {
  if (env.metricsToken) return env.metricsToken;
  const token = randomBytes(24).toString("hex");
  console.log(` No METRICS_TOKEN set — generated an ephemeral one for /metrics: ${token}`);
  return token;
}
