import { Networks } from "@stellar/stellar-sdk";
import type { AssetRef } from "@checkout/core";

export type StellarNetwork = "testnet" | "public";

export interface StellarConfig {
  network: StellarNetwork;
  horizonUrl: string;
  networkPassphrase: string;
  /** Issuer for USDC on the selected network. */
  usdcIssuer: string;
}

const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

const PASSPHRASE: Record<StellarNetwork, string> = {
  testnet: Networks.TESTNET,
  public: Networks.PUBLIC,
};

export function resolveStellarConfig(input: {
  network: StellarNetwork;
  horizonUrl?: string;
  usdcIssuer: string;
}): StellarConfig {
  return {
    network: input.network,
    horizonUrl: input.horizonUrl ?? DEFAULT_HORIZON[input.network],
    networkPassphrase: PASSPHRASE[input.network],
    usdcIssuer: input.usdcIssuer,
  };
}

/** Resolve a client-supplied asset code into a fully-qualified AssetRef. */
export function resolveAsset(code: "USDC" | "XLM", cfg: StellarConfig): AssetRef {
  if (code === "XLM") return { code: "XLM", issuer: null };
  return { code: "USDC", issuer: cfg.usdcIssuer };
}
