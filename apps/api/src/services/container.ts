import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
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
  DrizzleTokenRevocationRepository,
} from "../repos/index";
import { LinkService } from "./link-service";
import { WatcherLoop, startCashOutPoller } from "../worker/watcher-loop";
import { ChallengeService } from "./challenge";
import { horizonSignerFetcher } from "./horizon-signers";
import { SessionIssuer } from "./session";
import type { StellarTomlConfig } from "../routes/well-known";

export interface Container {
  service: LinkService;
  links: DrizzleLinkRepository;
  sellers: DrizzleSellerRepository;
  webhooks: DrizzleWebhookRepository;
  config: { network: string; horizonUrl: string; sellerWallet: string };
  auth: {
    challenge: ChallengeService;
    session: SessionIssuer;
    stellarToml: StellarTomlConfig;
    revocations: DrizzleTokenRevocationRepository;
    secureCookie: boolean;
  };
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
  const revocationsRepo = new DrizzleTokenRevocationRepository(db);

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

  const serverKeypair = resolveServerSigningKeypair();
  const challenge = new ChallengeService({
    serverKeypair,
    homeDomain: env.homeDomain,
    webAuthDomain: env.webAuthDomain,
    networkPassphrase: stellar.networkPassphrase,
    fetchAccountSigners: horizonSignerFetcher(stellar.horizonUrl),
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

  return {
    service,
    links: linksRepo,
    sellers: sellersRepo,
    webhooks: webhooksRepo,
    config: { network: stellar.network, horizonUrl: stellar.horizonUrl, sellerWallet },
    auth: { challenge, session, stellarToml, revocations: revocationsRepo, secureCookie: env.cookieSecure },
    start() {
      loop.start();
      stopPoller = startCashOutPoller(service, Math.max(3000, env.pollMs));
      const sweepTimer = setInterval(
        () => void revocationsRepo.sweepExpired(Math.floor(Date.now() / 1000)),
        60 * 60 * 1000, // hourly — revocation rows are cheap and self-limiting (max 24h lifetime) anyway
      );
      stopRevocationSweep = () => clearInterval(sweepTimer);
    },
    stop() {
      loop.stop();
      stopPoller?.();
      stopRevocationSweep?.();
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

/**
 * Resolves the keypair that SIGNS SEP-10 challenges — the platform's own login
 * identity, distinct from any seller's wallet. Required to be stable
 * (SERVER_SIGNING_SECRET) on public network; auto-generates a throwaway testnet
 * keypair otherwise, same convenience as `resolveSellerKeypairOrWallet`.
 */
function resolveServerSigningKeypair(): Keypair {
  if (env.serverSigningSecret) return Keypair.fromSecret(env.serverSigningSecret);
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
