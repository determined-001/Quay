import { afterEach, describe, expect, it, vi } from "vitest";
import { NOOP_LOGGER, type Logger, type Refund } from "@checkout/core";
import type { HorizonLookup, HorizonPayment, HorizonTransaction, StellarConfig } from "@checkout/stellar";
import { DisabledOffRamp } from "@checkout/offramp";
import { LinkService } from "../src/services/link-service";
import { startRefundPoller } from "../src/worker/watcher-loop";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeRefundRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
} from "./fakes";

const HASH = "3b1f0c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c";
const BUYER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const REFUNDER = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const USDC = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: USDC.issuer,
};

const SUCCESS: HorizonTransaction = {
  successful: true,
  memoType: null,
  memo: null,
  resultCode: "tx_success",
};

function payment(over: Partial<HorizonPayment> = {}): HorizonPayment {
  return { from: REFUNDER, to: BUYER, amount: "5.0000000", asset: USDC, ...over };
}

function refund(over: Partial<Refund> = {}): Refund {
  return {
    id: "rfd_1",
    linkId: "lnk_1",
    sellerId: "sel_1",
    paymentTxHash: "b".repeat(64),
    paymentOperationId: "1",
    destination: BUYER,
    destinationMuxedId: null,
    memo: null,
    memoType: null,
    amount: "5",
    asset: USDC,
    status: "submitted",
    txHash: HASH,
    failureReason: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

/** Horizon stub: one transaction, one set of payments, optional gate. */
class ScriptedHorizon implements HorizonLookup {
  txCalls = 0;
  paymentCalls = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(
    private readonly tx: HorizonTransaction | null | Error,
    private readonly payments: HorizonPayment[] = [],
    private readonly waitForGate = false,
  ) {}

  async getTransaction(): Promise<HorizonTransaction | null> {
    this.txCalls++;
    if (this.waitForGate) await this.gate;
    if (this.tx instanceof Error) throw this.tx;
    return this.tx;
  }

  async getPayments(): Promise<HorizonPayment[]> {
    this.paymentCalls++;
    return this.payments;
  }

  open(): void {
    this.release();
  }
}

function makeService(horizon: HorizonLookup, refunds = new FakeRefundRepository()) {
  const service = new LinkService({
    links: new FakeLinkRepository(),
    sellers: {
      findById: async () => null,
      findByWallet: async () => null,
      createIfAbsent: async () => {
        throw new Error("not used in these tests");
      },
      savePayoutFields: async () => {},
      saveProfileKind: async () => {},
    },
    webhooks: new FakeWebhookRepository(),
    rail: {
      async assertCanReceive() {},
      buildRequest() {
        throw new Error("not used in these tests");
      },
      isValidDestination() {
        return true;
      },
    },
    offramp: new DisabledOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    stellar: STELLAR,
    telemetry: new FakeTelemetryRepository(),
    correlation: "memo",
    webhookGuard: async () => ({ ok: true }) as const,
    refunds,
    horizon,
  });
  return { service, refunds };
}

function recordingLogger(): { logger: Logger; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  const logger: Logger = {
    child: () => logger,
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (...args: unknown[]) => {
      const first = args[0];
      if (first && typeof first === "object") errors.push(first as Record<string, unknown>);
    },
  };
  return { logger, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LinkService.pollRefunds (issue #538)", () => {
  it("confirms a successful transaction that pays the stored refund", async () => {
    const horizon = new ScriptedHorizon(SUCCESS, [payment()]);
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund());

    await service.pollRefunds();

    expect(await refunds.findById("rfd_1")).toMatchObject({
      status: "confirmed",
      failureReason: null,
    });
  });

  it("confirms a refund to a muxed account when the muxed id matches", async () => {
    const muxed = "MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const horizon = new ScriptedHorizon(SUCCESS, [
      payment({ to: muxed, toMuxed: BUYER, toMuxedId: "42" }),
    ]);
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund({ destinationMuxedId: "42" }));

    await service.pollRefunds();

    expect((await refunds.findById("rfd_1"))?.status).toBe("confirmed");
  });

  it("confirms when the required memo is on the transaction", async () => {
    const horizon = new ScriptedHorizon(
      { ...SUCCESS, memoType: "text", memo: "deposit 7781" },
      [payment()],
    );
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund({ memo: "deposit 7781", memoType: "text" }));

    await service.pollRefunds();

    expect((await refunds.findById("rfd_1"))?.status).toBe("confirmed");
  });

  it("fails a transaction that is on the ledger with successful: false, keeping the result code", async () => {
    const horizon = new ScriptedHorizon(
      { successful: false, memoType: null, memo: null, resultCode: "tx_failed" },
      [],
    );
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund());

    await service.pollRefunds();

    expect(await refunds.findById("rfd_1")).toMatchObject({
      status: "failed",
      failureReason: "tx_failed",
    });
  });

  it("fails a successful transaction that does not match the prepared refund, and logs at error level", async () => {
    const horizon = new ScriptedHorizon(SUCCESS, [payment({ amount: "4.9999999" })]);
    const { service, refunds } = makeService(horizon);
    const { logger, errors } = recordingLogger();
    await refunds.create(refund());

    await service.pollRefunds({ logger });

    expect(await refunds.findById("rfd_1")).toMatchObject({
      status: "failed",
      failureReason: "ledger_mismatch",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "refund.ledger_mismatch", mismatch: "amount" });
  });

  it("treats a different destination, asset or memo as ledger_mismatch", async () => {
    const cases: Array<{ name: string; horizon: ScriptedHorizon; refund: Partial<Refund> }> = [
      {
        name: "destination",
        horizon: new ScriptedHorizon(SUCCESS, [payment({ to: REFUNDER })]),
        refund: {},
      },
      {
        name: "asset",
        horizon: new ScriptedHorizon(SUCCESS, [
          payment({ asset: { code: "USDC", issuer: "GOTHERISSUER" } }),
        ]),
        refund: {},
      },
      {
        name: "memo",
        horizon: new ScriptedHorizon(
          { ...SUCCESS, memoType: "text", memo: "something else" },
          [payment()],
        ),
        refund: { memo: "deposit 7781", memoType: "text" },
      },
    ];

    for (const c of cases) {
      const { service, refunds } = makeService(c.horizon);
      const { logger, errors } = recordingLogger();
      await refunds.create(refund(c.refund));

      await service.pollRefunds({ logger });

      expect(await refunds.findById("rfd_1"), c.name).toMatchObject({
        status: "failed",
        failureReason: "ledger_mismatch",
      });
      expect(errors[0], c.name).toMatchObject({ event: "refund.ledger_mismatch", mismatch: c.name });
    }
  });

  it("leaves a 404 refund submitted before ten minutes, then fails it as not_found_on_ledger", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 10, 27, 12, 0, 0);
    vi.setSystemTime(now);
    const horizon = new ScriptedHorizon(null);
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund({ updatedAt: now - 9 * 60_000 }));

    await service.pollRefunds();
    expect((await refunds.findById("rfd_1"))?.status).toBe("submitted");

    // Ten minutes after submission: still unknown, so it never reached a ledger.
    vi.setSystemTime(now + 60_000);
    await service.pollRefunds();

    expect(await refunds.findById("rfd_1")).toMatchObject({
      status: "failed",
      failureReason: "not_found_on_ledger",
    });
  });

  it("leaves the refund submitted when Horizon errors", async () => {
    const horizon = new ScriptedHorizon(new Error("Horizon answered HTTP 502"));
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund());

    await service.pollRefunds();

    expect((await refunds.findById("rfd_1"))?.status).toBe("submitted");
  });

  it("does not settle the same refund twice when two ticks overlap", async () => {
    const horizon = new ScriptedHorizon(SUCCESS, [payment()], true);
    const { service, refunds } = makeService(horizon);
    await refunds.create(refund());

    const first = service.pollRefunds();
    const second = service.pollRefunds();
    horizon.open();
    await Promise.all([first, second]);

    // The second tick skipped the in-flight refund rather than looking it up.
    expect(horizon.txCalls).toBe(1);
    expect(await refunds.findById("rfd_1")).toMatchObject({ status: "confirmed" });
  });
});

describe("startRefundPoller (issue #538)", () => {
  it("does not start when REFUNDS_ENABLED is off", async () => {
    vi.useFakeTimers();
    const pollRefunds = vi.fn(async () => {});
    const stop = startRefundPoller({ pollRefunds }, 1_000, { enabled: false });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(pollRefunds).not.toHaveBeenCalled();
    stop();
  });

  it("polls on each interval when enabled, without overlapping ticks", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pollRefunds = vi.fn(() => gate);
    const stop = startRefundPoller({ pollRefunds }, 1_000, { enabled: true, logger: NOOP_LOGGER });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollRefunds).toHaveBeenCalledTimes(1);

    // Still running: the next interval must not start a second poll.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollRefunds).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollRefunds).toHaveBeenCalledTimes(2);

    stop();
  });
});
