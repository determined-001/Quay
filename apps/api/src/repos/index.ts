import { eq, and, inArray } from "drizzle-orm";
import type {
  CreateLinkInput,
  LinkRepository,
  PaymentLink,
  Seller,
  SellerRepository,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
  WatcherStateRepository,
  AssetRef,
} from "@checkout/core";
import type { DB } from "../db/client";
import { links, sellers, webhooks, webhookDeliveries, watcherCursors, processedTx, offrampTelemetry } from "../db/schema";
import { newId } from "../services/ids";

type LinkRow = typeof links.$inferSelect;

const OPEN_STATUSES = ["active", "underpaid"];

function assetFromRow(row: LinkRow): AssetRef {
  return { code: row.assetCode, issuer: row.assetIssuer ?? null };
}

function rowToLink(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    reference: row.reference,
    sellerId: row.sellerId,
    destination: row.destination,
    title: row.title,
    amount: row.amount,
    asset: assetFromRow(row),
    status: row.status as PaymentLink["status"],
    txHash: row.txHash ?? null,
    payer: row.payer ?? null,
    paidAmount: row.paidAmount ?? null,
    offrampJobId: row.offrampJobId ?? null,
    offrampTargetCurrency: row.offrampTargetCurrency ?? null,
    offrampStatus: row.offrampStatus ?? null,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleLinkRepository implements LinkRepository {
  constructor(private readonly db: DB) {}

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const now = Date.now();
    const row: LinkRow = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      title: input.title,
      amount: input.amount,
      assetCode: input.asset.code,
      assetIssuer: input.asset.issuer,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(links).values(row);
    return rowToLink(row);
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.id, id)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.reference, reference)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.sellerId, sellerId));
    return rows.map(rowToLink).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.status, status));
    return rows.map(rowToLink);
  }

  async activeDestinations(): Promise<string[]> {
    const rows = await this.db
      .select({ destination: links.destination })
      .from(links)
      .where(inArray(links.status, OPEN_STATUSES));
    return [...new Set(rows.map((r) => r.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(links)
      .where(and(eq(links.destination, destination), inArray(links.status, OPEN_STATUSES)));
    return rows.map(rowToLink);
  }

  async save(link: PaymentLink): Promise<void> {
    await this.db
      .update(links)
      .set({
        status: link.status,
        txHash: link.txHash,
        payer: link.payer,
        paidAmount: link.paidAmount,
        offrampJobId: link.offrampJobId,
        offrampTargetCurrency: link.offrampTargetCurrency,
        offrampStatus: link.offrampStatus,
        updatedAt: Date.now(),
      })
      .where(eq(links.id, link.id));
  }
}

export class DrizzleSellerRepository implements SellerRepository {
  constructor(private readonly db: DB) {}

  /** Seed (once) and return the single demo seller. */
  async ensureDefault(wallet: string, name: string): Promise<Seller> {
    const existing = await this.db.select().from(sellers).limit(1);
    if (existing[0]) {
      // keep the wallet in sync if it changed in env
      if (existing[0].wallet !== wallet) {
        await this.db.update(sellers).set({ wallet }).where(eq(sellers.id, existing[0].id));
      }
      return { ...existing[0], wallet };
    }
    const seller: Seller = { id: newId("sel"), name, wallet, createdAt: Date.now() };
    await this.db.insert(sellers).values(seller);
    return seller;
  }

  async getDefault(): Promise<Seller> {
    const rows = await this.db.select().from(sellers).limit(1);
    if (!rows[0]) throw new Error("No default seller seeded");
    return rows[0];
  }

  async findById(id: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
    return rows[0] ?? null;
  }
}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private readonly db: DB) {}

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = {
      id: newId("whk"),
      sellerId: input.sellerId,
      url: input.url,
      secret: input.secret,
      createdAt: Date.now(),
    };
    await this.db.insert(webhooks).values(hook);
    return hook;
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.db.select().from(webhooks).where(eq(webhooks.sellerId, sellerId));
  }

  async recordDelivery(d: WebhookDelivery): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: newId("whd"),
      webhookId: d.webhookId,
      linkId: d.linkId,
      event: d.event,
      statusCode: d.statusCode,
      ok: d.ok,
      error: d.error,
      createdAt: Date.now(),
    });
  }
}

export class DrizzleWatcherStateRepository implements WatcherStateRepository {
  constructor(private readonly db: DB) {}

  async getCursor(account: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(watcherCursors)
      .where(eq(watcherCursors.account, account))
      .limit(1);
    return rows[0]?.cursor ?? null;
  }

  async setCursor(account: string, cursor: string): Promise<void> {
    await this.db
      .insert(watcherCursors)
      .values({ account, cursor, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: watcherCursors.account,
        set: { cursor, updatedAt: Date.now() },
      });
  }

  async isProcessed(txHash: string): Promise<boolean> {
    const rows = await this.db
      .select({ txHash: processedTx.txHash })
      .from(processedTx)
      .where(eq(processedTx.txHash, txHash))
      .limit(1);
    return rows.length > 0;
  }

  async markProcessed(txHash: string, linkId: string | null): Promise<void> {
    await this.db
      .insert(processedTx)
      .values({ txHash, linkId, createdAt: Date.now() })
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Off-ramp telemetry repository
// ---------------------------------------------------------------------------

export interface TelemetryRow {
  id: string;
  anchorDomain: string;
  corridor: string;
  sellAsset: string;
  sellAmount: string;
  indicativeRate: string | null;
  quotedRate: string;
  quotedAt: number;
  initiatedAt: number | null;
  settledAt: number | null;
  effectiveRate: string | null;
  feeAmount: string | null;
  status: "quoted" | "initiated" | "settled" | "failed";
  failureReason: string | null;
}

export interface TelemetrySummary {
  anchorDomain: string;
  corridor: string;
  count: number;
  settledCount: number;
  failedCount: number;
  /** p50 settlement latency in ms (null when < 1 settled row). */
  latencyP50Ms: number | null;
  /** p95 settlement latency in ms (null when < 1 settled row). */
  latencyP95Ms: number | null;
  /** mean of (quotedRate - effectiveRate) / quotedRate, as a fraction (null when no data). */
  meanSpread: number | null;
}

export class DrizzleOfframpTelemetryRepository {
  constructor(private readonly db: DB) {}

  async upsert(row: TelemetryRow): Promise<void> {
    await this.db
      .insert(offrampTelemetry)
      .values({
        id: row.id,
        anchorDomain: row.anchorDomain,
        corridor: row.corridor,
        sellAsset: row.sellAsset,
        sellAmount: row.sellAmount,
        indicativeRate: row.indicativeRate,
        quotedRate: row.quotedRate,
        quotedAt: row.quotedAt,
        initiatedAt: row.initiatedAt,
        settledAt: row.settledAt,
        effectiveRate: row.effectiveRate,
        feeAmount: row.feeAmount,
        status: row.status,
        failureReason: row.failureReason,
      })
      .onConflictDoUpdate({
        target: offrampTelemetry.id,
        set: {
          initiatedAt: row.initiatedAt,
          settledAt: row.settledAt,
          effectiveRate: row.effectiveRate,
          feeAmount: row.feeAmount,
          status: row.status,
          failureReason: row.failureReason,
        },
      });
  }

  async findById(id: string): Promise<TelemetryRow | null> {
    const rows = await this.db
      .select()
      .from(offrampTelemetry)
      .where(eq(offrampTelemetry.id, id))
      .limit(1);
    return rows[0] ? this.toRow(rows[0]) : null;
  }

  async findByJobId(jobId: string): Promise<TelemetryRow | null> {
    // id is the telemetry row id which equals "tel_<jobId>" by convention in LinkService.
    return this.findById(`tel_${jobId}`);
  }

  async summary(): Promise<TelemetrySummary[]> {
    const all = await this.db.select().from(offrampTelemetry);
    // Group by (anchorDomain, corridor)
    const groups = new Map<string, (typeof all)[number][]>();
    for (const r of all) {
      const key = `${r.anchorDomain}||${r.corridor}`;
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }

    const result: TelemetrySummary[] = [];
    for (const rows of groups.values()) {
      const first = rows[0]!;
      const settled = rows.filter((r) => r.status === "settled");
      const failed = rows.filter((r) => r.status === "failed");

      // Settlement latency: initiatedAt -> settledAt
      const latencies = settled
        .filter((r) => r.initiatedAt != null && r.settledAt != null)
        .map((r) => r.settledAt! - r.initiatedAt!)
        .sort((a, b) => a - b);

      // Spread: (quotedRate - effectiveRate) / quotedRate
      const spreads = settled
        .filter((r) => r.effectiveRate != null)
        .map((r) => {
          const q = Number(r.quotedRate);
          const e = Number(r.effectiveRate!);
          return q === 0 ? 0 : (q - e) / q;
        });

      result.push({
        anchorDomain: first.anchorDomain,
        corridor: first.corridor,
        count: rows.length,
        settledCount: settled.length,
        failedCount: failed.length,
        latencyP50Ms: percentile(latencies, 50),
        latencyP95Ms: percentile(latencies, 95),
        meanSpread: spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      });
    }
    return result;
  }

  /** All rows ordered by quotedAt ascending — for CSV export. */
  async all(): Promise<TelemetryRow[]> {
    const rows = await this.db.select().from(offrampTelemetry);
    return rows
      .sort((a, b) => a.quotedAt - b.quotedAt)
      .map((r) => this.toRow(r));
  }

  private toRow(r: typeof offrampTelemetry.$inferSelect): TelemetryRow {
    return {
      id: r.id,
      anchorDomain: r.anchorDomain,
      corridor: r.corridor,
      sellAsset: r.sellAsset,
      sellAmount: r.sellAmount,
      indicativeRate: r.indicativeRate,
      quotedRate: r.quotedRate,
      quotedAt: r.quotedAt,
      initiatedAt: r.initiatedAt,
      settledAt: r.settledAt,
      effectiveRate: r.effectiveRate,
      feeAmount: r.feeAmount,
      status: r.status as TelemetryRow["status"],
      failureReason: r.failureReason,
    };
  }
}

/** Nearest-rank percentile. Returns null for empty arrays. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}
