import { describe, expect, it } from "vitest";
import {
  NOOP_LOGGER,
  type PaymentLink,
  type Seller,
  type SellerRepository,
  type TokenRevocationRepository,
} from "@checkout/core";
import type { Container } from "../src/services/container";
import { SessionIssuer } from "../src/services/session";
import { LINKS_CSV_HEADER, csvCell, linkRoutes, linkToCsvRow } from "../src/routes/links";

/**
 * Regression, BUG-4.13. `GET /links/export/csv` quoted cells but did not
 * neutralise leading formula characters, so a link title of
 * `=cmd|'/c calc'!A1` was written to the reconciliation export verbatim and
 * evaluated on open by Excel, LibreOffice and Google Sheets.
 */
describe("csvCell — spreadsheet formula injection", () => {
  it("prefixes the four formula-trigger characters with an apostrophe", () => {
    // Only double-quotes are doubled per RFC 4180; apostrophes pass through.
    expect(csvCell("=cmd|'/c calc'!A1")).toBe(`"'=cmd|'/c calc'!A1"`);
    expect(csvCell("+1+1")).toBe(`"'+1+1"`);
    expect(csvCell("-2+3")).toBe(`"'-2+3"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
  });

  it("guards leading tab and carriage return, which Excel also treats as formula starts", () => {
    expect(csvCell("\t=1+1")).toBe(`"'\t=1+1"`);
    expect(csvCell("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("leaves ordinary titles untouched apart from RFC 4180 quoting", () => {
    expect(csvCell("T-shirt")).toBe(`"T-shirt"`);
    expect(csvCell('Invoice "1024"')).toBe(`"Invoice ""1024"""`);
    expect(csvCell("")).toBe(`""`);
  });

  it("does not guard a hyphen that is not leading", () => {
    expect(csvCell("Blue T-shirt")).toBe(`"Blue T-shirt"`);
  });
});

describe("links CSV export — cash-out state", () => {
  const link = (over: Partial<PaymentLink> = {}): PaymentLink =>
    ({
      id: "lnk_1",
      reference: "ref1",
      title: "Invoice",
      amount: "10",
      asset: { code: "USDC", issuer: null },
      status: "offramp_pending",
      payer: null,
      txHash: null,
      paidAmount: null,
      createdAt: Date.UTC(2026, 0, 1),
      updatedAt: Date.UTC(2026, 0, 2),
      offrampStatus: null,
      ...over,
    }) as PaymentLink;

  it("adds offramp_status as the LAST column, so earlier columns keep their positions", () => {
    const cols = LINKS_CSV_HEADER.trim().split(",");
    expect(cols.slice(0, 11)).toEqual([
      "id", "reference", "title", "amount", "asset", "status",
      "payer", "tx_hash", "paid_amount", "created_at", "updated_at",
    ]);
    expect(cols.at(-1)).toBe("offramp_status");
  });

  it("tells a cash-out awaiting the seller's transfer from one the anchor is processing", () => {
    const awaiting = linkToCsvRow(link({ offrampStatus: "awaiting_transfer" })).split(",");
    const processing = linkToCsvRow(link({ offrampStatus: "pending" })).split(",");
    // `status` is identical, which is exactly why the extra column exists
    expect(awaiting[5]).toBe("offramp_pending");
    expect(processing[5]).toBe("offramp_pending");
    expect(awaiting.at(-1)).toBe("awaiting_transfer");
    expect(processing.at(-1)).toBe("pending");
  });

  it("leaves offramp_status empty for a link that was never cashed out", () => {
    const row = linkToCsvRow(link({ status: "paid", offrampStatus: null })).split(",");
    expect(row).toHaveLength(LINKS_CSV_HEADER.trim().split(",").length);
    expect(row.at(-1)).toBe("");
  });
});

describe("GET /links/export/csv — date range filtering (BUG-4.46)", () => {
  const owner: Seller = {
    id: "sel_owner",
    name: "Owner",
    wallet: "GOWNER",
    profileKind: "individual",
    payoutFields: null,
    createdAt: Date.now(),
  };

  const linkPrior: PaymentLink = {
    id: "lnk_prior",
    reference: "ref_prior",
    sellerId: owner.id,
    destination: owner.wallet,
    muxedId: null,
    title: "Prior day link",
    amount: "10",
    asset: { code: "USDC", issuer: null },
    status: "paid",
    txHash: null,
    payer: null,
    paidAmount: null,
    overpaidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    offrampFeeAmount: null,
    offrampFeeCurrency: null,
    offrampFeeSource: null,
    offrampNetTargetAmount: null,
    expiresAt: null,
    isDemo: false,
    createdAt: Date.UTC(2026, 9, 15, 12, 0, 0), // 2026-10-15T12:00:00Z
    updatedAt: Date.UTC(2026, 9, 15, 12, 0, 0),
  };

  const linkMidday: PaymentLink = {
    ...linkPrior,
    id: "lnk_midday",
    reference: "ref_midday",
    title: "Midday link",
    createdAt: Date.UTC(2026, 9, 16, 12, 0, 0), // 2026-10-16T12:00:00Z
    updatedAt: Date.UTC(2026, 9, 16, 12, 0, 0),
  };

  const linkNextDay: PaymentLink = {
    ...linkPrior,
    id: "lnk_next_day",
    reference: "ref_next_day",
    title: "Next day link",
    createdAt: Date.UTC(2026, 9, 17, 0, 0, 1), // 2026-10-17T00:00:01Z
    updatedAt: Date.UTC(2026, 9, 17, 0, 0, 1),
  };

  function setupRoute(links: PaymentLink[] = [linkPrior, linkMidday, linkNextDay]) {
    const sellersById = new Map([[owner.id, owner]]);
    const sellers: SellerRepository = {
      findById: async (id) => sellersById.get(id) ?? null,
      findByWallet: async () => null,
      createIfAbsent: async () => owner,
      savePayoutFields: async () => {},
      saveProfileKind: async () => {},
    };
    const revocations: TokenRevocationRepository = {
      revoke: async () => {},
      isRevoked: async () => false,
      sweepExpired: async () => {},
    };
    const session = new SessionIssuer("test-secret");

    const container = {
      service: {
        listLinks: async () => links,
      } as unknown as Container["service"],
      logger: NOOP_LOGGER,
      links: {} as Container["links"],
      sellers: sellers as unknown as Container["sellers"],
      webhooks: { listDeliveriesByLinkId: async () => [] } as unknown as Container["webhooks"],
      config: { network: "testnet", horizonUrl: "https://horizon-testnet.stellar.org", sellerWallet: owner.wallet },
      auth: { session, sellers, revocations } as unknown as Container["auth"],
      apiKeys: {} as Container["apiKeys"],
      kyc: {} as Container["kyc"],
      kycConsents: {
        async list() { return []; },
        async grant(consent: any) { return { ...consent, id: "cnc_1" }; },
        async active() { return null; },
        async revoke() {},
      } as unknown as Container["kycConsents"],
      anchorDomain: "testanchor.stellar.org",
      anchorAuth: null,
      db: {} as Container["db"],
      telemetry: { upsert: async () => {}, summary: async () => [], all: async () => [] } as unknown as Container["telemetry"],
      horizonStatus: () => ({ degraded: false, usingFallback: false, consecutiveFailures: 0 }),
      metricsToken: "test-metrics-token",
      ready: async () => true,
      watcherLagSeconds: () => 0,
      circuitBreakerState: () => 0,
      getWatcherCircuitBreakerStatus: () => [],
      getWatcherMetrics: () => ({
        accountsWatched: 0,
        tickDurationMs: 0,
        perAccountLag: new Map(),
        circuitBreakersOpen: 0,
      }),
      start() {},
      stop() {},
    } as unknown as Container;

    const app = linkRoutes(container, async (_c, next) => next());
    return { app, session };
  }

  it("includes links created midday on the date-only to date and excludes next-day links", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    const res = await app.request("/export/csv?to=2026-10-16", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(linkPrior.id);
    expect(csv).toContain(linkMidday.id);
    expect(csv).not.toContain(linkNextDay.id);
  });

  it("treats date-only from as start of UTC day and includes midday and next-day links", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    const res = await app.request("/export/csv?from=2026-10-16", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).not.toContain(linkPrior.id);
    expect(csv).toContain(linkMidday.id);
    expect(csv).toContain(linkNextDay.id);
  });

  it("filters with both date-only from and to to capture only links created on that day", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    const res = await app.request("/export/csv?from=2026-10-16&to=2026-10-16", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).not.toContain(linkPrior.id);
    expect(csv).toContain(linkMidday.id);
    expect(csv).not.toContain(linkNextDay.id);
  });

  it("preserves exact cutoffs when full ISO timestamps are provided", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    // Cutoff before midday link
    const resBefore = await app.request("/export/csv?to=2026-10-16T11:00:00.000Z", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resBefore.status).toBe(200);
    const csvBefore = await resBefore.text();
    expect(csvBefore).toContain(linkPrior.id);
    expect(csvBefore).not.toContain(linkMidday.id);
    expect(csvBefore).not.toContain(linkNextDay.id);

    // Exact cutoff at midday link
    const resExact = await app.request("/export/csv?to=2026-10-16T12:00:00.000Z", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resExact.status).toBe(200);
    const csvExact = await resExact.text();
    expect(csvExact).toContain(linkPrior.id);
    expect(csvExact).toContain(linkMidday.id);
    expect(csvExact).not.toContain(linkNextDay.id);
  });

  it("returns 400 invalid_query when from is unparsable", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    const res = await app.request("/export/csv?from=garbage", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_query", message: "unparsable 'from' date" });
  });

  it("returns 400 invalid_query when to is unparsable", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    const res = await app.request("/export/csv?to=garbage", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_query", message: "unparsable 'to' date" });
  });

  it("returns all links when neither from nor to is provided", async () => {
    const { app, session } = setupRoute();
    const { token } = await session.issue({ sub: "GSUB", sellerId: owner.id });

    const res = await app.request("/export/csv", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(linkPrior.id);
    expect(csv).toContain(linkMidday.id);
    expect(csv).toContain(linkNextDay.id);
  });
});
