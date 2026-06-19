import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { resolveStellarConfig, StellarRail, HorizonWatcher } from "@checkout/stellar";
import { MockAnchorOffRamp } from "@checkout/offramp";
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

  const { db, client } = createDb(env.databaseUrl);
  await bootstrap(client);

  const linksRepo = new DrizzleLinkRepository(db);
  const sellersRepo = new DrizzleSellerRepository(db);
  const webhooksRepo = new DrizzleWebhookRepository(db);
  const stateRepo = new DrizzleWatcherStateRepository(db);

  const sellerWallet = resolveSellerWallet();
  await sellersRepo.ensureDefault(sellerWallet, env.defaultSellerName);

  const rail = new StellarRail(stellar);
  const watcher = new HorizonWatcher(stellar.horizonUrl);
  // Demo off-ramp: settles 8s after a seller triggers cash-out. NOT a real anchor.
  const offramp = new MockAnchorOffRamp({ settleAfterMs: 8000 });

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

function resolveSellerWallet(): string {
  if (env.defaultSellerWallet) {
    if (!StrKey.isValidEd25519PublicKey(env.defaultSellerWallet)) {
      throw new Error("DEFAULT_SELLER_WALLET is not a valid Stellar G-address");
    }
    return env.defaultSellerWallet;
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
  return pub;
}
