import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { Logger } from "pino";
import { env } from "../env";

// Deliberately its own module rather than a function inside container.ts.
// container.ts imports the entire application graph — Drizzle, the Stellar
// rail, the off-ramp adapters, the Redis client — so a test that wants to
// exercise this one decision had to load all of it, and did so slowly enough
// to time out. The decision itself needs three things: the environment, a
// Stellar keypair, and somewhere to log.

/**
 * `Keypair.fromSecret` on a malformed value throws `invalid encoded string`
 * from inside the SDK's base32 decoder — no variable name, no shape, no fix.
 * Every other misconfiguration in this service refuses to boot with a sentence
 * that names what is wrong; this one used to refuse to boot with a stack trace
 * pointing at strkey.js, which tells an operator nothing about which of their
 * environment variables to look at.
 *
 * The common mistake is real and specific: a Stellar secret seed is `S` plus
 * 55 base32 characters, but three of the four values `pnpm secrets:mainnet`
 * prints are 64 hex characters, so pasting the wrong line produces exactly
 * this crash.
 */
export function keypairFromSecret(secret: string, varName: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed !== secret) {
    throw new Error(
      `${varName} has leading or trailing whitespace — it was probably pasted with a newline. Remove it and redeploy.`,
    );
  }
  if (!StrKey.isValidEd25519SecretSeed(trimmed)) {
    const looksHex = /^[0-9a-f]{64}$/i.test(trimmed);
    throw new Error(
      `${varName} is not a valid Stellar secret seed. Expected "S" followed by 55 characters (56 total), got ${trimmed.length} character(s)` +
        (looksHex
          ? " that look like a 64-character hex string — that is the shape of JWT_SECRET / METRICS_TOKEN / WEBHOOK_SECRET_ENCRYPTION_KEY, so this is most likely the wrong line pasted into the wrong variable."
          : ".") +
        ' Generate one with: node -e "const {Keypair}=require(\'@stellar/stellar-sdk\');console.log(Keypair.random().secret())"',
    );
  }
  return Keypair.fromSecret(trimmed);
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
export function resolveSellerKeypairOrWallet(logger: Logger): { keypair: Keypair | null; publicKey: string | null } {
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
    const kp = keypairFromSecret(env.defaultSellerSecret, "DEFAULT_SELLER_SECRET");
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
    // Deliberately not an error any more. Before wallet-native auth this was
    // the only seller there was, so booting without it meant booting with
    // nowhere to be paid. Now every seller brings their own wallet at login,
    // and a pubnet deployment that serves other people's merchants has no
    // reason to name one of them in its own environment.
    logger.info(
      { event: "seller.multi_tenant", network: env.network },
      "no DEFAULT_SELLER_WALLET — sellers supply their own wallet at SEP-10 login",
    );
    return { keypair: null, publicKey: null };
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
