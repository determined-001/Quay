export type StellarNetwork = "public" | "testnet";

export function getNetwork(override?: string): StellarNetwork {
  const raw = override ?? process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  return raw === "public" ? "public" : "testnet";
}

export function networkLabel(network?: string): string {
  return getNetwork(network) === "public" ? "Mainnet" : "Testnet";
}

export function explorerUrl(hash: string, network?: string): string;
export function explorerUrl(network: string, hash: string): string;
export function explorerUrl(arg1: string, arg2?: string): string {
  if (arg2 !== undefined) {
    if (arg1 === "public" || arg1 === "testnet") {
      const net = getNetwork(arg1);
      return `https://stellar.expert/explorer/${net}/tx/${arg2}`;
    }
    const net = getNetwork(arg2);
    return `https://stellar.expert/explorer/${net}/tx/${arg1}`;
  }
  const net = getNetwork();
  return `https://stellar.expert/explorer/${net}/tx/${arg1}`;
}

export function addressUrl(addr: string, network?: string): string;
export function addressUrl(network: string, addr: string): string;
export function addressUrl(arg1: string, arg2?: string): string {
  if (arg2 !== undefined) {
    if (arg1 === "public" || arg1 === "testnet") {
      const net = getNetwork(arg1);
      return `https://stellar.expert/explorer/${net}/account/${arg2}`;
    }
    const net = getNetwork(arg2);
    return `https://stellar.expert/explorer/${net}/account/${arg1}`;
  }
  const net = getNetwork();
  return `https://stellar.expert/explorer/${net}/account/${arg1}`;
}
