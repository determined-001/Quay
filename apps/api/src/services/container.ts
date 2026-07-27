import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { resolveStellarConfig, StellarRail, HorizonWatcher } from "@checkout/stellar";
import { MockAnchorOffRamp, TestAnchorOffRamp } from "@checkout/offramp";
import type { Logger, OffRampPort } from "@checkout/core";
import { env } from "../env";
import { createDb, bootstrap } from "../db/client";
import {
  DrizzleLinkRepository,
  DrizzleSellerRepository,
  DrizzleWebhookRepository,
  DrizzleWatcherStateRepository,
} from "../repos/index";
import { LinkService } from "./link-service";
import { WatcherLoop, startCashOutPoller } from "../worker/watcher-loop";
import { createLogger } from "../logger";

export interface Container {
  service: LinkService;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  logger: Logger;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  start(): void;
  stop(): void;
}

export async function createContainer(): Promise<Container> {
  // Root pino logger is the single source. The request-context middleware
  // builds child loggers bound to requestId/method/path and routes pass
  // those children explicitly into service calls — so deep subsystems
  // (LinkService, off-ramp adapters, webhook sender) inherit requestId
  // without us needing any ambient / AsyncLocalStorage plumbing.
  const logger = createLogger({ level: env.logLevel, base: { network: env.network } });

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

  const seller = resolveSellerKeypairOrWallet(logger);
  const sellerWallet = seller.publicKey;
  await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  const rail = new StellarRail(stellar);
  const watcher = new HorizonWatcher(stellar.horizonUrl);
  const offramp = createOffRamp(seller.keypair, logger);

  const service = new LinkService({
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    rail,
    offramp,
    stellar,
    logger,
  });

  const loop = new WatcherLoop({
    watcher,
    links: linksRepo,
    state: stateRepo,
    service,
    pollMs: env.pollMs,
    logger,
  });

  let stopPoller: (() => void) | null = null;

  return {
    service,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    logger,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet },
    start() {
      logger.info({ event: "watcher.start", pollMs: env.pollMs }, "watcher started");
      loop.start();
      stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs), logger);
    },
    stop() {
      loop.stop();
      stopPoller?.();
    },
  };
}

/**
 * Resolves the seller's public key, plus its Keypair when we actually hold the
 * secret in-memory (auto-generated testnet keypair, or DEFAULT_SELLER_SECRET
 * explicitly supplied). The Keypair is only needed to sign the SEP-10 auth
 * challenge for `OFFRAMP=testanchor` — never persisted beyond this process.
 *
 * The one human-facing line of output (the testnet convenience banner with
 * the secret) is guarded by `LOG_LEVEL=debug|trace` so an ordinary run never
 * echoes the seller key. When plaintext output is wanted, set LOG_LEVEL=debug.
 */
function resolveSellerKeypairOrWallet(logger: Logger): { keypair: Keypair | null; publicKey: string } {
  if (env.defaultSellerWallet) {
    if (!StrKey.isValidEd25519PublicKey(env.defaultSellerWallet)) {
      throw new Error("DEFAULT_SELLER_WALLET is not a valid Stellar G-address");
    }
    if (!env.defaultSellerSecret) {
      logger.info(
        { event: "seller.configured", wallet: env.defaultSellerWallet, hasSecret: false, network: env.network },
        "seller wallet configured (no secret loaded)",
      );
      return { keypair: null, publicKey: env.defaultSellerWallet };
    }
    const kp = Keypair.fromSecret(env.defaultSellerSecret);
    if (kp.publicKey() !== env.defaultSellerWallet) {
      throw new Error("DEFAULT_SELLER_SECRET does not match DEFAULT_SELLER_WALLET");
    }
    logger.info(
      { event: "seller.configured", wallet: kp.publicKey(), hasSecret: true, network: env.network },
      "seller wallet configured (secret loaded)",
    );
    return { keypair: kp, publicKey: kp.publicKey() };
  }
  if (env.network === "public") {
    throw new Error("Set DEFAULT_SELLER_WALLET to your wallet address before running on public network");
  }
  // Testnet convenience: generate a throwaway account and tell the operator how to fund it.
  // The plaintext secret banner is opt-in (LOG_LEVEL=debug|trace) so an ordinary
  // pino runtime never echoes a secret.
  const kp = Keypair.random();
  const pub = kp.publicKey();
  logger.warn(
    {
      event: "seller.generated",
      publicKey: pub,
      fund: `https://friendbot.stellar.org/?addr=${pub}`,
      network: env.network,
    },
    "no DEFAULT_SELLER_WALLET set — generated throwaway testnet seller",
  );
  if (process.env.LOG_LEVEL === "debug" || process.env.LOG_LEVEL === "trace") {
    process.stdout.write(
      [
        "",
        "──────────────────────────────────────────────────────────────────",
        " Testnet seller key (LOG_LEVEL=debug printed this once):",
        ` Public key (receives funds): ${pub}`,
        ` Secret key (import into a wallet to move funds): ${kp.secret()}`,
        " Set DEFAULT_SELLER_WALLET/DEFAULT_SELLER_SECRET in .env to reuse.",
        "──────────────────────────────────────────────────────────────────",
        "",
      ].join("\n") + "\n",
    );
  }
  return { keypair: kp, publicKey: pub };
}

function createOffRamp(sellerKeypair: Keypair | null, logger: Logger): OffRampPort {
  if (env.offramp === "mock") {
    logger.info({ event: "offramp.selected", adapter: "mock" }, "off-ramp adapter selected");
    return new MockAnchorOffRamp({
      settleAfterMs: 8000,
      logger,
    });
  }
  if (!sellerKeypair) {
    throw new Error(
      "OFFRAMP=testanchor requires the seller's secret key to sign SEP-10 auth: " +
        "set DEFAULT_SELLER_SECRET (matching DEFAULT_SELLER_WALLET), or leave " +
        "DEFAULT_SELLER_WALLET unset on testnet to use the auto-generated keypair.",
    );
  }
  logger.info({ event: "offramp.selected", adapter: "testanchor", baseUrl: "https://testanchor.stellar.org" }, "off-ramp adapter selected");
  return new TestAnchorOffRamp({ sellerKeypair, logger });
}


