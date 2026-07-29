import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { resolveStellarConfig, StellarRail, HorizonWatcher, StreamingHorizonWatcher } from "@checkout/stellar";
import { MockAnchorOffRamp, TestAnchorOffRamp } from "@checkout/offramp";
import type { OffRampPort } from "@checkout/core";
import { env } from "../env";
import { createDb, bootstrap } from "../db/client";
import {
  DrizzleApiKeyRepository,
  DrizzleLinkRepository,
  DrizzleSellerRepository,
  DrizzleWebhookRepository,
  DrizzleWatcherStateRepository,
} from "../repos/index";
import { LinkService, AnchorHealth } from "./link-service";
import { generateApiKey } from "./api-keys";
import { makeAuth, makeSingleTenantDevAuth, type Auth } from "../middleware/auth";
import {
  WatcherLoop,
  startCashOutPoller,
  startAnchorProbeTimer,
  type AccountCircuitBreakerStatus,
  type WatcherMetrics,
} from "../worker/watcher-loop";

export interface Container {
  service: LinkService;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  auth: Auth;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  start(): void;
  stop(): void;
  getWatcherCircuitBreakerStatus(): AccountCircuitBreakerStatus[];
  getWatcherMetrics(): WatcherMetrics;
}

export async function createContainer(): Promise<Container> {
  const stellar = resolveStellarConfig({
    network: env.network,
    horizonUrl: env.horizonUrl,
    usdcIssuer: env.usdcIssuer,
  });

  const { db, client } = createDb(env.databaseUrl, env.databaseAuthToken);
  await bootstrap(client);

  const linksRepo = new DrizzleLinkRepository(db);
  const sellersRepo = new DrizzleSellerRepository(db);
  const webhooksRepo = new DrizzleWebhookRepository(db);
  const stateRepo = new DrizzleWatcherStateRepository(db);
  const apiKeysRepo = new DrizzleApiKeyRepository(db);

  const seller = resolveSellerKeypairOrWallet();
  const sellerWallet = seller.publicKey;
  const defaultSeller = await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  // Multi-tenant auth (issue 6.4). SINGLE_TENANT_DEV bypasses the API-key
  // requirement entirely for local dev - env.ts already refuses to boot with
  // it set under NODE_ENV=production, so that escape hatch cannot reach a
  // real deployment.
  const auth = env.singleTenantDev
    ? makeSingleTenantDevAuth(() => defaultSeller.id)
    : makeAuth({ apiKeys: apiKeysRepo });

  // Bootstrap usability: outside single-tenant dev mode, something has to
  // hand the operator a credential the first time, since there's no
  // sign-up flow yet (issues 6.1/6.2 own that). Mirrors the existing
  // "no DEFAULT_SELLER_WALLET -> generate + print" pattern below - mint once,
  // print once, never again. This is the entire "migration path" issue 6.4
  // asks for: existing single-tenant rows already carry a real sellerId
  // (ensureDefault has always assigned one), so the only new requirement is
  // that seller having a key to authenticate with.
  if (!env.singleTenantDev) {
    const existingKeys = await apiKeysRepo.findBySeller(defaultSeller.id);
    if (existingKeys.length === 0) {
      const { raw, hash } = generateApiKey();
      await apiKeysRepo.create({ sellerId: defaultSeller.id, keyHash: hash });
      console.log(
        [
          "",
          "──────────────────────────────────────────────────────────────────",
          " No API key existed yet for the seeded seller - minted one.",
          ` API key (store it now - it is never shown again): ${raw}`,
          " Use it as: Authorization: Bearer " + raw,
          "──────────────────────────────────────────────────────────────────",
          "",
        ].join("\n"),
      );
    }
  }

  const rail = new StellarRail(stellar);
  const watcher =
    env.watchMode === "stream"
      ? new StreamingHorizonWatcher(stellar.horizonUrl, { log: (m) => console.log(`[watcher:stream] ${m}`) })
      : new HorizonWatcher(stellar.horizonUrl);
  const offramp = createOffRamp(seller.keypair);

  // Anchor health probe + circuit breaker (issue #19, 3.7). In mock mode the
  // probe is disabled and short-circuits to "always available" so the dev
  // surface still works offline; in testanchor mode we hit the real anchor.
  const anchorHealth = buildAnchorHealth(env.offramp);

  const service = new LinkService({
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    rail,
    offramp,
    stellar,
    health: anchorHealth,
  });

  const loop = new WatcherLoop({
    watcher,
    links: linksRepo,
    state: stateRepo,
    service,
    pollMs: env.pollMs,
    log: (m) => console.log(`[watcher] ${m}`),
  });

  let stopPoller: (() => void) | null = null;
  let stopProbe: (() => void) | null = null;

  return {
    service,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    auth,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet },
    start() {
      loop.start();
      stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs));
      stopProbe = startAnchorProbeTimer(anchorHealth, 60_000);
    },
    async stop() {
      await loop.stop();
      stopPoller?.();
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
  };
}

/**
 * Build an AnchorHealth with sensible defaults anchored at the public Stellar
 * testnet reference sandbox. Caller can override via env (read raw — we keep
 * the surface minimal and don't pollute env.ts which lives outside the
 * scope of issue 3.7).
 */
function buildAnchorHealth(offrampKind: "mock" | "testanchor"): AnchorHealth {
  const enabled = offrampKind === "testanchor";
  const url = enabled ? process.env.ANCHOR_URL ?? "https://testanchor.stellar.org" : null;
  const homeDomain = enabled ? process.env.ANCHOR_HOME_DOMAIN ?? "testanchor.stellar.org" : null;
  const failureThreshold = Number(process.env.ANCHOR_PROBE_FAILURE_THRESHOLD ?? "3");
  const cooldownMs = Number(process.env.ANCHOR_PROBE_COOLDOWN_MS ?? "30000");
  return new AnchorHealth({
    enabled,
    url,
    homeDomain,
    failureThreshold: Number.isFinite(failureThreshold) && failureThreshold > 0 ? failureThreshold : 3,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 30_000,
  });
}

/**
 * Resolves the seller's public key, plus its Keypair when we actually hold the
 * secret in-memory (auto-generated testnet keypair, or DEFAULT_SELLER_SECRET
 * explicitly supplied). The Keypair is only needed to sign the SEP-10 auth
 * challenge for `OFFRAMP=testanchor` — never persisted beyond this process.
 */
function resolveSellerKeypairOrWallet(): { keypair: Keypair | null; publicKey: string } {
  if (env.defaultSellerWallet) {
    if (!StrKey.isValidEd25519PublicKey(env.defaultSellerWallet)) {
      throw new Error("DEFAULT_SELLER_WALLET is not a valid Stellar G-address");
    }
    if (!env.defaultSellerSecret) {
      return { keypair: null, publicKey: env.defaultSellerWallet };
    }
    const kp = Keypair.fromSecret(env.defaultSellerSecret);
    if (kp.publicKey() !== env.defaultSellerWallet) {
      throw new Error("DEFAULT_SELLER_SECRET does not match DEFAULT_SELLER_WALLET");
    }
    return { keypair: kp, publicKey: kp.publicKey() };
  }
  if (env.network === "public") {
    throw new Error("Set DEFAULT_SELLER_WALLET to your wallet address before running on public network");
  }
  // Testnet convenience: generate a throwaway account and tell the operator how to fund it.
  const kp = Keypair.random();
  const pub = kp.publicKey();
  console.log(
    [
      "",
      "──────────────────────────────────────────────────────────────────",
      " No DEFAULT_SELLER_WALLET set — generated a TESTNET seller keypair.",
      ` Public key (receives funds): ${pub}`,
      ` Secret key (import into a wallet to move funds): ${kp.secret()}`,
      " Fund it: https://friendbot.stellar.org/?addr=" + pub,
      " Set DEFAULT_SELLER_WALLET in .env to reuse a stable address across restarts.",
      "──────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  return { keypair: kp, publicKey: pub };
}

function createOffRamp(sellerKeypair: Keypair | null): OffRampPort {
  if (env.offramp === "mock") {
    // Demo off-ramp: settles 8s after a seller triggers cash-out. NOT a real anchor.
    return new MockAnchorOffRamp({ settleAfterMs: 8000 });
  }
  if (!sellerKeypair) {
    throw new Error(
      "OFFRAMP=testanchor requires the seller's secret key to sign SEP-10 auth: " +
        "set DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET), or leave " +
        "DEFAULT_SELLER_WALLET unset on testnet to use the auto-generated keypair.",
    );
  }
  return new TestAnchorOffRamp({ sellerKeypair });
}
