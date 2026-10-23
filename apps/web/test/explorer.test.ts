import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addressUrl,
  explorerUrl,
  getNetwork,
  networkLabel,
} from "../lib/explorer";

describe("explorer helpers", () => {
  const origEnv = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    } else {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = origEnv;
    }
  });

  describe("testnet (default)", () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    });

    it("defaults to testnet network", () => {
      expect(getNetwork()).toBe("testnet");
    });

    it("formats network label as Testnet", () => {
      expect(networkLabel()).toBe("Testnet");
    });

    it("formats transaction explorer url for testnet", () => {
      expect(explorerUrl("tx12345")).toBe(
        "https://stellar.expert/explorer/testnet/tx/tx12345"
      );
    });

    it("formats account address url for testnet", () => {
      expect(addressUrl("GACCOUNT123")).toBe(
        "https://stellar.expert/explorer/testnet/account/GACCOUNT123"
      );
    });
  });

  describe("public (mainnet)", () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = "public";
    });

    it("resolves public network", () => {
      expect(getNetwork()).toBe("public");
    });

    it("formats network label as Mainnet", () => {
      expect(networkLabel()).toBe("Mainnet");
    });

    it("formats transaction explorer url for public network", () => {
      expect(explorerUrl("tx67890")).toBe(
        "https://stellar.expert/explorer/public/tx/tx67890"
      );
    });

    it("formats account address url for public network", () => {
      expect(addressUrl("GACCOUNT456")).toBe(
        "https://stellar.expert/explorer/public/account/GACCOUNT456"
      );
    });
  });

  describe("explicit overrides", () => {
    it("respects explicit public override", () => {
      delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
      expect(networkLabel("public")).toBe("Mainnet");
      expect(explorerUrl("tx123", "public")).toBe(
        "https://stellar.expert/explorer/public/tx/tx123"
      );
      expect(addressUrl("GADDR", "public")).toBe(
        "https://stellar.expert/explorer/public/account/GADDR"
      );
    });

    it("respects explicit testnet override when env is public", () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = "public";
      expect(networkLabel("testnet")).toBe("Testnet");
      expect(explorerUrl("tx123", "testnet")).toBe(
        "https://stellar.expert/explorer/testnet/tx/tx123"
      );
      expect(addressUrl("GADDR", "testnet")).toBe(
        "https://stellar.expert/explorer/testnet/account/GADDR"
      );
    });

    it("supports (network, target) order for backwards compatibility", () => {
      expect(explorerUrl("public", "tx123")).toBe(
        "https://stellar.expert/explorer/public/tx/tx123"
      );
      expect(addressUrl("public", "GADDR")).toBe(
        "https://stellar.expert/explorer/public/account/GADDR"
      );
      expect(explorerUrl("testnet", "tx123")).toBe(
        "https://stellar.expert/explorer/testnet/tx/tx123"
      );
      expect(addressUrl("testnet", "GADDR")).toBe(
        "https://stellar.expert/explorer/testnet/account/GADDR"
      );
    });
  });
});
