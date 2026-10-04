import { describe, expect, it } from "vitest";
import type { Logger, StoredOffRampJob, WithdrawTransfer } from "@checkout/core";
import { bootstrap, createDb, type DB } from "../src/db/client";
import { DrizzleOffRampStateRepository } from "../src/repos/index";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

// Issue 3.9: SEP-6 deposit instructions that arrive after the withdraw call are
// persisted on the job row and announced once.

const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
const TRANSFER: WithdrawTransfer = {
  destination: "GANCHORDEPOSIT",
  amount: "10",
  asset: USDC,
  memo: "4242",
  memoType: "id",
};

function job(over: Partial<StoredOffRampJob> = {}): StoredOffRampJob {
  return {
    jobId: "wd_1",
    linkId: "lnk_1",
    anchor: "anchor.example",
    sellerId: "sel_1",
    account: "GSELLER",
    targetCurrency: "NGN",
    targetAmount: "",
    rate: "1650",
    status: "pending",
    externalStatus: null,
    lastError: null,
    sellAsset: USDC,
    sellAmount: "10",
    transferNotifiedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

async function makeDb(): Promise<DB> {
  const { db, client } = createDb(":memory:");
  await bootstrap(client);
  return db;
}

describe("DrizzleOffRampStateRepository — deposit instructions", () => {
  it("round-trips the sold asset and the instructions written later by updateJob", async () => {
    const repo = new DrizzleOffRampStateRepository(await makeDb());
    await repo.saveJob(job());

    const before = await repo.getJob("wd_1");
    expect(before).toMatchObject({ sellAsset: USDC, sellAmount: "10", transfer: null });

    await repo.updateJob("wd_1", { externalStatus: "pending_user_transfer_start", transfer: TRANSFER });
    expect((await repo.getJob("wd_1"))?.transfer).toEqual(TRANSFER);

    // A later poll that carries no instructions must not wipe them.
    await repo.updateJob("wd_1", { externalStatus: "pending_external" });
    expect((await repo.getJob("wd_1"))?.transfer).toEqual(TRANSFER);
  });

  it("stores native-asset issuer as null and treats a row without a sell asset as unknown", async () => {
    const repo = new DrizzleOffRampStateRepository(await makeDb());
    await repo.saveJob(job({ jobId: "wd_xlm", sellAsset: { code: "XLM", issuer: null } }));
    await repo.saveJob(job({ jobId: "wd_old", sellAsset: undefined, sellAmount: undefined }));
    expect((await repo.getJob("wd_xlm"))?.sellAsset).toEqual({ code: "XLM", issuer: null });
    expect((await repo.getJob("wd_old"))?.sellAsset).toBeNull();
  });
});

describe("LinkService.pollCashOuts — cashout.transfer_required", () => {
  function recordingLogger() {
    const events: Array<Record<string, unknown>> = [];
    const logger: Logger = {
      child: () => logger,
      info: (...args: unknown[]) => {
        if (args[0] && typeof args[0] === "object") events.push(args[0] as Record<string, unknown>);
      },
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    return { logger, events };
  }

  function service(offramp: ScriptedOffRamp, offrampState: FakeOffRampStateRepository) {
    const links = new FakeLinkRepository([
      makeLink({ status: "offramp_pending", offrampJobId: "wd_1", offrampStatus: "pending" }),
    ]);
    return new LinkService({
      links,
      sellers: {
        findById: async () => null,
        findByWallet: async () => null,
        createIfAbsent: async () => {
          throw new Error("unused");
        },
        savePayoutFields: async () => {},
        saveProfileKind: async () => {},
      },
      webhooks: new FakeWebhookRepository(),
      rail: { async assertCanReceive() {}, buildRequest: () => { throw new Error("unused"); }, isValidDestination: () => true },
      offramp,
      offrampState,
      kyc: new AlwaysAcceptedKyc(),
      stellar: {
        network: "testnet",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        usdcIssuer: USDC.issuer,
      },
      telemetry: new FakeTelemetryRepository(),
      correlation: "memo",
      webhookGuard: async () => ({ ok: true }) as const,
    });
  }

  it("logs once, without the memo, the first time a job reports a transfer", async () => {
    const offrampState = new FakeOffRampStateRepository();
    await offrampState.saveJob(job());
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => {
      // Mirrors TestAnchorOffRamp.status(): persist, then return.
      await offrampState.updateJob(jobId, { transfer: TRANSFER });
      return { jobId, linkId: "lnk_1", status: "pending", targetCurrency: "NGN", targetAmount: "", rate: "1650", transfer: TRANSFER };
    };
    const { logger, events } = recordingLogger();
    const svc = service(offramp, offrampState);

    await svc.pollCashOuts({ logger });
    await svc.pollCashOuts({ logger });

    const required = events.filter((e) => e.event === "cashout.transfer_required");
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ linkId: "lnk_1", jobId: "wd_1" });
    expect(JSON.stringify(required[0])).not.toContain("4242");
  });

  it("does not log when the job reports no transfer", async () => {
    const offramp = new ScriptedOffRamp();
    offramp.statusImpl = async (jobId) => ({
      jobId, linkId: "lnk_1", status: "pending", targetCurrency: "NGN", targetAmount: "", rate: "1650",
    });
    const { logger, events } = recordingLogger();
    await service(offramp, new FakeOffRampStateRepository()).pollCashOuts({ logger });
    expect(events.some((e) => e.event === "cashout.transfer_required")).toBe(false);
  });
});
