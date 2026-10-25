import { afterEach, describe, expect, it, vi } from "vitest";
import { addressUrl, explorerUrl, networkLabel, stellarNetwork } from "../lib/explorer";

describe("explorer links follow NEXT_PUBLIC_STELLAR_NETWORK", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("points at the public explorer on mainnet", () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public");
    expect(stellarNetwork()).toBe("public");
    expect(explorerUrl("abc123")).toBe("https://stellar.expert/explorer/public/tx/abc123");
    expect(addressUrl("GADDR")).toBe("https://stellar.expert/explorer/public/account/GADDR");
    expect(networkLabel()).toBe("Mainnet");
  });

  it("points at the testnet explorer on testnet", () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "testnet");
    expect(stellarNetwork()).toBe("testnet");
    expect(explorerUrl("abc123")).toBe("https://stellar.expert/explorer/testnet/tx/abc123");
    expect(addressUrl("GADDR")).toBe("https://stellar.expert/explorer/testnet/account/GADDR");
    expect(networkLabel()).toBe("Testnet");
  });

  it("defaults to testnet when unset or unrecognised, never reading the API-side variable", () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "");
    vi.stubEnv("STELLAR_NETWORK", "public");
    expect(stellarNetwork()).toBe("testnet");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "mainnet");
    expect(stellarNetwork()).toBe("testnet");
  });

  it("accepts an explicit network, for callers that already know it", () => {
    expect(explorerUrl("h", "public")).toBe("https://stellar.expert/explorer/public/tx/h");
    expect(networkLabel("public")).toBe("Mainnet");
  });
});
