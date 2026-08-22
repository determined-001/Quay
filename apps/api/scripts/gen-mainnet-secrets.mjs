#!/usr/bin/env node
/**
 * Generates every secret a public-network deployment requires.
 *
 * Prints to stdout and writes nothing. That is deliberate: these values are
 * spending authority over real funds and identity for SEP-10 login, so they
 * must never land in a file the repo could pick up, in shell history, or in an
 * agent transcript. Copy each one straight into your platform's secret manager
 * and close the terminal.
 *
 *   pnpm secrets:mainnet
 *
 * It lives under apps/api/ because that is the workspace that depends on
 * @stellar/stellar-sdk — pnpm's strict node_modules means a script in the repo
 * root cannot resolve it.
 *
 * The two Stellar keys are generated but NOT funded — see docs/MAINNET.md for
 * what each needs before the service will work.
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

const hex = () => randomBytes(32).toString("hex");

const seller = Keypair.random();
const signer = Keypair.random();

const out = [
  "",
  "═".repeat(78),
  "  MAINNET SECRETS — real money. Copy into your secret manager, then close",
  "  this terminal. Nothing here was written to disk.",
  "═".repeat(78),
  "",
  "# --- Symmetric keys (64 hex chars each) ---",
  `JWT_SECRET=${hex()}`,
  `KYC_ENCRYPTION_KEY=${hex()}`,
  `WEBHOOK_SECRET_ENCRYPTION_KEY=${hex()}`,
  `METRICS_TOKEN=${hex()}`,
  "",
  "# --- Seller wallet: receives customer funds ---",
  "# Needs a USDC trustline and enough XLM for the base reserve before it can",
  "# be paid. Fund and add the trustline from a wallet, not from this script.",
  `DEFAULT_SELLER_WALLET=${seller.publicKey()}`,
  `DEFAULT_SELLER_SECRET=${seller.secret()}`,
  "",
  "# --- Platform SEP-10 signing identity (also the on-chain attester) ---",
  "# Published as SIGNING_KEY in /.well-known/stellar.toml. Rotating it logs",
  "# every wallet out. Needs XLM only if you enable Soroban attestation.",
  `SERVER_SIGNING_SECRET=${signer.secret()}`,
  `#   (public key, for reference: ${signer.publicKey()})`,
  "",
  "═".repeat(78),
  "  Still to supply by hand: ANCHOR_URL, ANCHOR_HOME_DOMAIN, DATABASE_URL,",
  "  DATABASE_AUTH_TOKEN, CORS_ORIGINS. See .env.public.example.",
  "═".repeat(78),
  "",
];

process.stdout.write(out.join("\n") + "\n");
