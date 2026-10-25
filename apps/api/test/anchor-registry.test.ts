import { describe, expect, it, vi } from "vitest";
import type { AnchorCustomer, OffRampInitiation, OffRampJob, OffRampQuote, SellerPayoutRef } from "@checkout/core";
import {
  AnchorRegistry,
  anchorDomainOfJob,
  seedAnchorsFromEnv,
  type AnchorEntry,
  type AnchorRecord,
  type AnchorRepository,
} from "../src/services/anchor-registry";
import { DrizzleAnchorRepository } from "../src/repos/index";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedKyc,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";
import { withTestDb } from "./setup";

function record(domain: string, over: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    id: `anc_${domain}`,
    homeDomain: domain,
    baseUrl: `https://${domain}`,
    displayName: domain,
    enabled: true,
    protocol: "auto",
    withdrawType: null,
    corridors: [],
    rateSource: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

class MemoryAnchors implements AnchorRepository {
  constructor(public rows: AnchorRecord[] = []) {}
  async list() {
    return [...this.rows].sort((a, b) => a.createdAt - b.createdAt);
  }
  async insert(r: AnchorRecord) {
    this.rows.push(r);
  }
  async setEnabled(domain: string, enabled: boolean, now = 2) {
    const row = this.rows.find((r) => r.homeDomain === domain);
    if (!row) return false;
    row.enabled = enabled;
    row.updatedAt = now;
    return true;
  }
}

/** A registry whose "adapters" are scripted fakes, one set per anchor, recording who was called. */
function harness(rows: AnchorRecord[], opts: { preferredDomain?: string } = {}) {
  const repo = new MemoryAnchors(rows);
  const adapters = new Map<string, { offramp: ScriptedOffRamp; kyc: ScriptedKyc; sessions: Set<string> }>();
  const built: string[] = [];
  const state = new FakeOffRampStateRepository();

  const registry = new AnchorRegistry({
    repo,
    ttlMs: 0,
    ...opts,
    build: async (r) => {
      built.push(r.homeDomain);
      const offramp = new ScriptedOffRamp();
      const kyc = new ScriptedKyc();
      kyc.statusImpl = async (c) => new AlwaysAcceptedKyc().status(c);
      const sessions = new Set<string>(["sel_1"]);
      adapters.set(r.homeDomain, { offramp, kyc, sessions });
      offramp.quoteImpl = async (input) => quoteFor(input.targetCurrency, input.linkId);
      offramp.initiateImpl = async (input) => {
        const jobId = `job_${r.homeDomain}_${input.linkId}`;
        await state.saveJob({
          jobId,
          linkId: input.linkId,
          anchor: r.homeDomain,
          sellerId: "sel_1",
          account: "GSELLER",
          targetCurrency: input.payout.currency,
          targetAmount: "",
          rate: "1",
          status: "pending",
          externalStatus: null,
          lastError: null,
          transferNotifiedAt: null,
          createdAt: 1,
          updatedAt: 1,
        });
        return { kind: "fields", jobId } satisfies OffRampInitiation;
      };
      offramp.statusImpl = async (jobId) =>
        ({ jobId, linkId: "x", status: "settled", targetCurrency: "NGN", targetAmount: "1", rate: "1" }) satisfies OffRampJob;
      return {
        discovery: {} as never,
        auth: {
          sessionExpiry: async (c: AnchorCustomer) => (sessions.has(c.sellerId) ? Date.now() + 1000 : null),
        } as never,
        offramp: offramp as never,
        kyc,
        health: {} as never,
      };
    },
  });
  return { registry, repo, adapters, built, state };
}

function quoteFor(targetCurrency: string, linkId: string): OffRampQuote {
  return {
    quoteId: `q_${linkId}_${targetCurrency}`,
    sourceAsset: { code: "USDC", issuer: "GISSUER" },
    sourceAmount: "10",
    targetCurrency,
    targetAmount: "100",
    rate: "10",
    expiresAt: Date.now() + 300_000,
    fee: { amount: "0", currency: targetCurrency, source: "estimated" },
    netTargetAmount: "100",
    quoteKind: "firm",
  };
}

describe("AnchorRegistry", () => {
  it("serves a currency from the anchor that lists it, else from an any-currency anchor", async () => {
    const { registry } = harness([
      record("any.example", { createdAt: 1 }),
      record("kes.example", { createdAt: 2, corridors: ["KES"] }),
    ]);
    expect((await registry.forCurrency("kes"))?.domain).toBe("kes.example");
    expect((await registry.forCurrency("NGN"))?.domain).toBe("any.example");
  });

  it("serves nothing for a currency no enabled anchor covers", async () => {
    const { registry } = harness([record("ngn.example", { corridors: ["NGN"] })]);
    expect(await registry.forCurrency("KES")).toBeNull();
    expect(await registry.forCurrency("NGN")).not.toBeNull();
  });

  it("never routes a new cash-out to a disabled anchor, but still finds it for its jobs", async () => {
    const { registry } = harness([record("a.example", { enabled: false })]);
    expect(await registry.forCurrency("NGN")).toBeNull();
    expect((await registry.forJob("a.example"))?.domain).toBe("a.example");
    expect((await registry.forJob("a.example#sep24"))?.domain).toBe("a.example");
    expect(await registry.fallback()).toBeNull();
  });

  it("prefers the configured default anchor, else the oldest enabled one", async () => {
    const rows = [record("old.example", { createdAt: 1 }), record("env.example", { createdAt: 2 })];
    expect((await harness(rows, { preferredDomain: "env.example" }).registry.fallback())?.domain).toBe("env.example");
    expect((await harness(rows).registry.fallback())?.domain).toBe("old.example");
  });

  it("builds an anchor once and reuses it; a changed row is rebuilt", async () => {
    const { registry, repo, built } = harness([record("a.example")]);
    await registry.forCurrency("NGN");
    await registry.forCurrency("KES");
    await registry.forJob("a.example");
    expect(built).toEqual(["a.example"]);

    await repo.setEnabled("a.example", false, 99);
    await registry.forJob("a.example");
    expect(built).toEqual(["a.example", "a.example"]);
  });

  it("picks up an anchor added after boot once the table is re-read", async () => {
    let now = 0;
    const repo = new MemoryAnchors([record("a.example")]);
    const registry = new AnchorRegistry({
      repo,
      ttlMs: 1000,
      now: () => now,
      build: async () => ({ discovery: {} as never, auth: {} as never, offramp: {} as never, kyc: new AlwaysAcceptedKyc(), health: {} as never }),
    });
    expect((await registry.list()).map((r) => r.homeDomain)).toEqual(["a.example"]);
    await repo.insert(record("b.example", { createdAt: 2 }));
    expect(await registry.list()).toHaveLength(1); // still within the TTL
    now = 1500;
    expect((await registry.list()).map((r) => r.homeDomain)).toEqual(["a.example", "b.example"]);
  });

  it("a misbuilt anchor is skipped, logged and retried, without taking the others down", async () => {
    const repo = new MemoryAnchors([record("bad.example", { corridors: ["NGN"] }), record("good.example", { createdAt: 2 })]);
    let attempts = 0;
    const registry = new AnchorRegistry({
      repo,
      ttlMs: 0,
      build: async (r) => {
        if (r.homeDomain === "bad.example" && ++attempts < 2) throw new Error("rate source misconfigured");
        return { discovery: {} as never, auth: {} as never, offramp: {} as never, kyc: new AlwaysAcceptedKyc(), health: {} as never };
      },
    });
    expect(await registry.forCurrency("NGN")).toBeNull(); // bad.example failed to build
    expect((await registry.forCurrency("KES"))?.domain).toBe("good.example");
    expect((await registry.forCurrency("NGN"))?.domain).toBe("bad.example"); // retried, now fine
    await expect(
      new AnchorRegistry({ repo, build: async () => { throw new Error("boom"); } }).warm(),
    ).rejects.toThrow("boom"); // boot is strict
  });

  it("answers the poller's live-session check against the job's own anchor", async () => {
    const { registry, adapters } = harness([record("a.example"), record("b.example", { createdAt: 2 })]);
    await registry.warm();
    adapters.get("b.example")!.sessions.clear();
    const seller = { sellerId: "sel_1", account: "GSELLER" };
    expect(await registry.hasLiveSession(seller, "a.example")).toBe(true);
    expect(await registry.hasLiveSession(seller, "b.example")).toBe(false);
    expect(await registry.hasLiveSession(seller, "b.example#sep24")).toBe(false);
  });

  it("anchorDomainOfJob strips the SEP-24 marker only", () => {
    expect(anchorDomainOfJob("a.example#sep24")).toBe("a.example");
    expect(anchorDomainOfJob("a.example")).toBe("a.example");
  });
});

describe("seedAnchorsFromEnv", () => {
  const cfg = {
    offramp: "anchor",
    homeDomain: "anchor.example",
    baseUrl: "https://anchor.example",
    protocol: "sep24" as const,
    withdrawType: "bank_account",
    rateSource: "static",
  };

  it("seeds one any-currency row from the env on an empty table", async () => {
    const repo = new MemoryAnchors();
    const seeded = await seedAnchorsFromEnv(repo, cfg, () => "anc_1", 5);
    expect(seeded).toEqual({
      id: "anc_1", homeDomain: "anchor.example", baseUrl: "https://anchor.example", displayName: "anchor.example",
      enabled: true, protocol: "sep24", withdrawType: "bank_account", corridors: [], rateSource: "static",
      createdAt: 5, updatedAt: 5,
    });
    expect(repo.rows).toHaveLength(1);
  });

  it("seeds for testanchor too, and leaves optional settings null", async () => {
    const repo = new MemoryAnchors();
    const seeded = await seedAnchorsFromEnv(repo, { ...cfg, offramp: "testanchor", withdrawType: undefined, rateSource: undefined }, () => "anc_1");
    expect(seeded).toMatchObject({ withdrawType: null, rateSource: null });
  });

  it("does nothing for mock or none, or when the table already has a row", async () => {
    for (const offramp of ["mock", "none"]) {
      const repo = new MemoryAnchors();
      expect(await seedAnchorsFromEnv(repo, { ...cfg, offramp }, () => "x")).toBeNull();
      expect(repo.rows).toEqual([]);
    }
    const repo = new MemoryAnchors([record("existing.example")]);
    expect(await seedAnchorsFromEnv(repo, cfg, () => "x")).toBeNull();
    expect(repo.rows.map((r) => r.homeDomain)).toEqual(["existing.example"]);
  });
});

describe("DrizzleAnchorRepository", () => {
  it("round-trips a row through the real table and toggles enabled", async () => {
    const { db, client } = await withTestDb();
    const repo = new DrizzleAnchorRepository(db);
    const row = record("a.example", { corridors: ["NGN", "KES"], withdrawType: "bank_account", rateSource: "sep38", protocol: "sep6" });
    await repo.insert(row);
    await repo.insert(record("b.example", { createdAt: 2 }));

    expect(await repo.list()).toEqual([row, record("b.example", { createdAt: 2 })]);
    expect(await repo.setEnabled("a.example", false, 77)).toBe(true);
    expect(await repo.setEnabled("missing.example", false)).toBe(false);
    expect((await repo.list())[0]).toMatchObject({ enabled: false, updatedAt: 77 });
    await expect(repo.insert(record("a.example", { id: "anc_dup" }))).rejects.toThrow(); // home_domain is unique
    client.close();
  });
});

describe("LinkService with several anchors (issue 3.21)", () => {
  function setup(h: ReturnType<typeof harness>, links: FakeLinkRepository) {
    return new LinkService({
      links,
      sellers: {
        findById: async (id) =>
          id === "sel_1" ? { id: "sel_1", name: "Seller", wallet: "GSELLER", profileKind: "individual", payoutFields: null, createdAt: 0 } : null,
        findByWallet: async () => null,
        createIfAbsent: async () => { throw new Error("unused"); },
        savePayoutFields: async () => {},
        saveProfileKind: async () => {},
      },
      webhooks: new FakeWebhookRepository(),
      rail: { async assertCanReceive() {}, buildRequest() { throw new Error("unused"); }, isValidDestination: () => true },
      // The single-adapter fields: must never be reached once a router is given.
      offramp: new ScriptedOffRamp(),
      offrampState: h.state,
      kyc: new AlwaysAcceptedKyc(),
      stellar: {
        network: "testnet",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
      telemetry: new FakeTelemetryRepository(),
      correlation: "memo",
      webhookGuard: async () => ({ ok: true }) as const,
      anchors: h.registry,
      hasLiveAnchorSession: (c, label) => h.registry.hasLiveSession(c, label),
    });
  }

  const twoAnchors = () =>
    harness([
      record("ngn.example", { createdAt: 1, corridors: ["NGN"] }),
      record("kes.example", { createdAt: 2, corridors: ["KES"] }),
    ]);

  it("sends a cash-out in currency A to anchor A and one in currency B to anchor B", async () => {
    const h = twoAnchors();
    const links = new FakeLinkRepository([makeLink({ id: "lnk_ngn" }), makeLink({ id: "lnk_kes", reference: "pl_2" })]);
    const service = setup(h, links);
    await h.registry.warm();

    const ngn = await service.triggerCashOut("lnk_ngn", { targetCurrency: "NGN", payoutFields: {} });
    const kes = await service.triggerCashOut("lnk_kes", { targetCurrency: "KES", payoutFields: {} });

    expect(ngn.job.jobId).toBe("job_ngn.example_lnk_ngn");
    expect(kes.job.jobId).toBe("job_kes.example_lnk_kes");
    expect((await h.state.getJob(ngn.job.jobId))?.anchor).toBe("ngn.example");
    expect((await h.state.getJob(kes.job.jobId))?.anchor).toBe("kes.example");
  });

  it("answers 422 corridor_unavailable, touching no anchor, for a currency nobody serves", async () => {
    const h = twoAnchors();
    const service = setup(h, new FakeLinkRepository([makeLink()]));
    const quote = vi.spyOn(ScriptedOffRamp.prototype, "quote");

    await expect(service.triggerCashOut("lnk_1", { targetCurrency: "GHS", payoutFields: {} })).rejects.toMatchObject({
      status: 422,
      message: "corridor_unavailable",
      extra: { targetCurrency: "GHS" },
    });
    await expect(service.quoteCashOut("lnk_1", "GHS")).rejects.toMatchObject({ status: 422, message: "corridor_unavailable" });
    expect(quote).not.toHaveBeenCalled();
    quote.mockRestore();
  });

  it("gates the cash-out on the KYC of the anchor serving it, not another anchor's", async () => {
    const h = twoAnchors();
    const service = setup(h, new FakeLinkRepository([makeLink({ id: "lnk_ngn" }), makeLink({ id: "lnk_kes", reference: "pl_2" })]));
    await h.registry.warm();
    h.adapters.get("kes.example")!.kyc.statusImpl = async (c) => ({
      ...(await new AlwaysAcceptedKyc().status(c)),
      status: "NEEDS_INFO",
    });

    await expect(service.triggerCashOut("lnk_kes", { targetCurrency: "KES", payoutFields: {} })).rejects.toMatchObject({
      status: 403,
      message: "kyc_required",
    });
    await expect(service.triggerCashOut("lnk_ngn", { targetCurrency: "NGN", payoutFields: {} })).resolves.toBeDefined();
  });

  it("keeps polling a job on the anchor that created it after another anchor is added", async () => {
    const h = harness([record("a.example", { createdAt: 1 })]);
    const links = new FakeLinkRepository([makeLink({ id: "lnk_a" })]);
    const service = setup(h, links);
    await h.registry.warm();

    const { job } = await service.triggerCashOut("lnk_a", { targetCurrency: "NGN", payoutFields: {} });
    await h.repo.insert(record("b.example", { createdAt: 2, corridors: ["NGN"] }));
    await h.registry.warm();
    // From now on new NGN cash-outs would prefer B, but this job is A's.
    expect((await h.registry.forCurrency("NGN"))?.domain).toBe("b.example");

    const statusA = vi.spyOn(h.adapters.get("a.example")!.offramp, "status");
    const statusB = vi.spyOn(h.adapters.get("b.example")!.offramp, "status");
    await service.pollCashOuts();

    expect(statusA).toHaveBeenCalledWith(job.jobId, expect.anything());
    expect(statusB).not.toHaveBeenCalled();
    expect(links.get("lnk_a")?.status).toBe("offramp_settled");
  });

  it("still polls a job of an anchor that has since been disabled", async () => {
    const h = harness([record("a.example")]);
    const links = new FakeLinkRepository([makeLink({ id: "lnk_a" }), makeLink({ id: "lnk_new", reference: "pl_2" })]);
    const service = setup(h, links);
    await service.triggerCashOut("lnk_a", { targetCurrency: "NGN", payoutFields: {} });
    await h.repo.setEnabled("a.example", false, 9);

    await service.pollCashOuts();

    expect(links.get("lnk_a")?.status).toBe("offramp_settled");
    await expect(service.quoteCashOut("lnk_new", "NGN")).rejects.toMatchObject({ message: "corridor_unavailable" });
  });

  it("blocks a poll on the job's own anchor session, not the default anchor's", async () => {
    const h = twoAnchors();
    const links = new FakeLinkRepository([makeLink({ id: "lnk_kes" })]);
    const service = setup(h, links);
    await h.registry.warm();
    await service.triggerCashOut("lnk_kes", { targetCurrency: "KES", payoutFields: {} });
    h.adapters.get("kes.example")!.sessions.clear(); // signed out of KES only; NGN's session is fine
    const status = vi.spyOn(h.adapters.get("kes.example")!.offramp, "status");

    await service.pollCashOuts();

    expect(status).not.toHaveBeenCalled();
    expect(links.get("lnk_kes")?.status).toBe("offramp_pending");
  });
});
