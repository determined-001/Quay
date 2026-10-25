import type { Context } from "hono";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { NOOP_LOGGER, type Logger } from "@checkout/core";
import type { DB } from "../db/client";
import { piiAudit } from "../db/schema";
import { metrics } from "../metrics";
import type { AuthVariables } from "../middleware/auth";
import { newId } from "./ids";

/**
 * Audit log for access to a seller's identity data (issue 8.15).
 *
 * It answers "whose PII was read, by what, and when" after a suspected breach,
 * so it records the access and NEVER the data: `fields` holds field names
 * (`first_name`), not values. Rows are written where plaintext leaves the
 * repository toward a caller (a route handler or a system path), not inside
 * every decrypt.
 *
 * `anchor_session.decrypt` is part of the action vocabulary but is deliberately
 * NOT emitted: the anchor bearer token never leaves the server to a caller, it
 * is decrypted in-process on every anchor call, and a row per call would bury
 * the access events that matter. Add it only if a path ever hands that token to
 * a caller.
 */
export type PiiAuditActorType = "session" | "api_key" | "system";

export type PiiAuditAction =
  | "kyc.read"
  | "kyc.submit"
  | "profile.read"
  | "profile.write"
  | "profile.export"
  | "profile.erase"
  | "anchor_session.decrypt";

export interface PiiAuditEntry {
  sellerId: string;
  actorType: PiiAuditActorType;
  /** Seller id for a session, the API key id for a key, a fixed label for the system. */
  actorId: string;
  action: PiiAuditAction;
  /** Field NAMES only. Values must never be passed here. */
  fields?: readonly string[];
  requestId?: string | null;
}

export interface PiiAuditRow {
  id: string;
  at: number;
  sellerId: string;
  actorType: PiiAuditActorType;
  actorId: string;
  action: PiiAuditAction;
  fields: string[];
  requestId: string | null;
}

/** What callers depend on, so code paths can take a no-op or a fake. */
export interface PiiAuditRecorder {
  record(entry: PiiAuditEntry): Promise<void>;
}

/** Audit rows older than this are deleted by the daily sweep. */
export const PII_AUDIT_RETENTION_DAYS = 730;
export const PII_AUDIT_PAGE_DEFAULT = 50;
export const PII_AUDIT_PAGE_MAX = 200;

function toRow(r: typeof piiAudit.$inferSelect): PiiAuditRow {
  let fields: string[] = [];
  if (r.fields) {
    try {
      const parsed: unknown = JSON.parse(r.fields);
      if (Array.isArray(parsed)) fields = parsed.filter((f): f is string => typeof f === "string");
    } catch {
      fields = [];
    }
  }
  return {
    id: r.id,
    at: r.at,
    sellerId: r.sellerId,
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action as PiiAuditAction,
    fields,
    requestId: r.requestId,
  };
}

/** Opaque keyset cursor over (at, id), newest first. */
export function encodeAuditCursor(row: Pick<PiiAuditRow, "at" | "id">): string {
  return Buffer.from(`${row.at}|${row.id}`).toString("base64url");
}

export function decodeAuditCursor(cursor: string): { at: number; id: string } | null {
  const raw = Buffer.from(cursor, "base64url").toString();
  const sep = raw.indexOf("|");
  if (sep < 1) return null;
  const at = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isSafeInteger(at) || !id) return null;
  return { at, id };
}

/**
 * Who is making this request, for an audit row: the seller themselves on a
 * session, the key's id on an API key. Needs the auth middleware to have run.
 */
export function auditActor(
  ctx: Context<{ Variables: AuthVariables }>,
): Pick<PiiAuditEntry, "sellerId" | "actorType" | "actorId" | "requestId"> {
  const seller = ctx.get("seller");
  const requestId = ctx.get("requestId") ?? null;
  if (ctx.get("authKind") === "api_key") {
    return { sellerId: seller.id, actorType: "api_key", actorId: ctx.get("apiKeyId") ?? "unknown", requestId };
  }
  return { sellerId: seller.id, actorType: "session", actorId: seller.id, requestId };
}

export class PiiAuditService implements PiiAuditRecorder {
  constructor(
    private readonly db: DB,
    private readonly logger: Logger = NOOP_LOGGER,
  ) {}

  /**
   * Best-effort and never throws: an audit failure must not fail the seller's
   * request. It is not silent either: it logs `pii_audit.write_failed` and
   * increments `pii_audit_write_failures_total`, which an operator alerts on.
   */
  async record(entry: PiiAuditEntry): Promise<void> {
    try {
      await this.db.insert(piiAudit).values({
        id: newId("pia"),
        at: Date.now(),
        sellerId: entry.sellerId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        fields: entry.fields && entry.fields.length > 0 ? JSON.stringify([...entry.fields]) : null,
        requestId: entry.requestId ?? null,
      });
    } catch (err) {
      metrics.piiAuditWriteFailuresTotal.inc();
      try {
        this.logger.error(
          {
            event: "pii_audit.write_failed",
            action: entry.action,
            actorType: entry.actorType,
            sellerId: entry.sellerId,
            requestId: entry.requestId ?? null,
            error: err instanceof Error ? err.message : String(err),
          },
          "failed to write PII audit entry",
        );
      } catch {
        // a broken logger must not turn into a failed request either
      }
    }
  }

  /**
   * Newest first, one page. `sellerId` and `action` narrow the result; pass
   * the previous page's `nextCursor` as `cursor` to continue.
   */
  async list(opts: {
    sellerId?: string;
    action?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ entries: PiiAuditRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? PII_AUDIT_PAGE_DEFAULT), 1), PII_AUDIT_PAGE_MAX);
    const conditions = [];
    if (opts.sellerId) conditions.push(eq(piiAudit.sellerId, opts.sellerId));
    if (opts.action) conditions.push(eq(piiAudit.action, opts.action));
    if (opts.cursor) {
      const c = decodeAuditCursor(opts.cursor);
      if (!c) throw new InvalidAuditCursorError();
      conditions.push(
        or(lt(piiAudit.at, c.at), and(eq(piiAudit.at, c.at), lt(piiAudit.id, c.id))),
      );
    }
    const rows = await this.db
      .select()
      .from(piiAudit)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(piiAudit.at), desc(piiAudit.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map(toRow);
    const last = page[page.length - 1];
    return {
      entries: page,
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last) : null,
    };
  }

  /** A seller's own entries, newest first, for their privacy export. One extra row signals truncation. */
  async listForSeller(sellerId: string, limit: number): Promise<PiiAuditRow[]> {
    const rows = await this.db
      .select()
      .from(piiAudit)
      .where(eq(piiAudit.sellerId, sellerId))
      .orderBy(desc(piiAudit.at), desc(piiAudit.id))
      .limit(limit);
    return rows.map(toRow);
  }
}

export class InvalidAuditCursorError extends Error {
  constructor() {
    super("invalid cursor");
  }
}

export interface PiiAuditSweepOptions {
  db: DB;
  now?: number;
  retentionDays?: number;
  logger?: Logger;
}

/** Deletes audit rows older than the retention window; newer rows are never touched. */
export async function runPiiAuditSweep(opts: PiiAuditSweepOptions): Promise<{ deleted: number }> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.retentionDays ?? PII_AUDIT_RETENTION_DAYS) * 86_400_000;
  const removed = await opts.db.delete(piiAudit).where(lt(piiAudit.at, cutoff)).returning({ id: piiAudit.id });
  opts.logger?.info({ event: "pii_audit.swept", count: removed.length }, "PII audit retention sweep completed");
  return { deleted: removed.length };
}
