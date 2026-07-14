import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { resolveStellarConfig, StellarRail, HorizonWatcher } from "@checkout/stellar";
import { MockAnchorOffRamp, TestAnchorOffRamp } from "@checkout/offramp";
import type { OffRampPort } from "@checkout/core";
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

export interface Container {
  service: LinkService;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  start(): void;
  stop(): void;
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

  const seller = resolveSellerKeypairOrWallet();
  const sellerWallet = seller.publicKey;
  await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  const rail = new StellarRail(stellar);
  const watcher = new HorizonWatcher(stellar.horizonUrl);
  const offramp = createOffRamp(seller.keypair);

  const service = new LinkService({
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    rail,
    offramp,
    stellar,
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

  return {
    service,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet },
    start() {
      loop.start();
      stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs));
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
