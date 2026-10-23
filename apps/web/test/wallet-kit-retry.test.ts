import { beforeEach, describe, expect, it, vi } from "vitest";

describe("wallet.ts kit() retry on failure (issue #420)", () => {
  let initMock: any;
  let refreshMock: any;

  beforeEach(() => {
    vi.resetModules();
    initMock = vi.fn();
    refreshMock = vi.fn(async () => [{ isAvailable: true }]);

    vi.doMock("@creit.tech/stellar-wallets-kit/sdk", () => ({
      StellarWalletsKit: {
        init: initMock,
        refreshSupportedWallets: refreshMock,
      },
    }));

    vi.doMock("@creit.tech/stellar-wallets-kit/types", () => ({
      Networks: {
        PUBLIC: "public",
        TESTNET: "testnet",
      },
    }));

    vi.doMock("@creit.tech/stellar-wallets-kit/modules/freighter", () => ({
      FreighterModule: vi.fn(),
    }));
    vi.doMock("@creit.tech/stellar-wallets-kit/modules/xbull", () => ({
      xBullModule: vi.fn(),
    }));
    vi.doMock("@creit.tech/stellar-wallets-kit/modules/albedo", () => ({
      AlbedoModule: vi.fn(),
    }));
    vi.doMock("@creit.tech/stellar-wallets-kit/modules/rabet", () => ({
      RabetModule: vi.fn(),
    }));
    vi.doMock("@creit.tech/stellar-wallets-kit/modules/lobstr", () => ({
      LobstrModule: vi.fn(),
    }));
    vi.doMock("@creit.tech/stellar-wallets-kit/modules/hana", () => ({
      HanaModule: vi.fn(),
    }));
  });

  it("retries loading when StellarWalletsKit.init throws once and succeeds on retry", async () => {
    initMock
      .mockImplementationOnce(() => {
        throw new Error("Simulated kit init failure");
      })
      .mockImplementation(() => {});

    const { detectWallet } = await import("../lib/wallet");

    // First call: init throws, detectWallet rejects with the error
    await expect(detectWallet()).rejects.toThrow("Simulated kit init failure");
    expect(initMock).toHaveBeenCalledTimes(1);

    // Second call: init succeeds, detectWallet resolves true
    await expect(detectWallet()).resolves.toBe(true);
    expect(initMock).toHaveBeenCalledTimes(2);

    // Third call: cached promise is reused, init is NOT called again
    await expect(detectWallet()).resolves.toBe(true);
    expect(initMock).toHaveBeenCalledTimes(2);
  });
});
