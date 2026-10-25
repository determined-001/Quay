/**
 * Block-explorer links for the network this deployment runs on.
 *
 * Reads `NEXT_PUBLIC_STELLAR_NETWORK`, the one variable docs/MAINNET.md tells
 * operators to set on the web service. The API-side `STELLAR_NETWORK` has no
 * `NEXT_PUBLIC_` prefix, so a separately deployed web app never sees it and
 * every mainnet receipt linked to the testnet explorer (issue 5.30).
 */
export type StellarNetwork = "public" | "testnet";

export function stellarNetwork(): StellarNetwork {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === "public" ? "public" : "testnet";
}

function explorerBase(network: StellarNetwork): string {
  return network === "public" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
}

export function explorerUrl(hash: string, network: StellarNetwork = stellarNetwork()): string {
  return `${explorerBase(network)}/tx/${hash}`;
}

export function addressUrl(address: string, network: StellarNetwork = stellarNetwork()): string {
  return `${explorerBase(network)}/account/${address}`;
}

/** "Mainnet" or "Testnet", for copy such as "Settled on Stellar Mainnet". */
export function networkLabel(network: StellarNetwork = stellarNetwork()): string {
  return network === "public" ? "Mainnet" : "Testnet";
}
