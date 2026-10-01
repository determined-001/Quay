import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Container } from "../services/container";

/**
 * GET /telemetry/summary
 *   Returns aggregated stats per (anchor, corridor): count, p50/p95 settlement
 *   latency, mean quoted-vs-effective spread.
 *
 * GET /telemetry/export.csv
 *   Full anonymised CSV dump — suitable for periodic export to the public dataset.
 *   Columns: corridor, sell_asset, sell_amount, quoted_rate, quoted_at,
 *            initiated_at, settled_at, effective_rate, fee_amount, status
 *   Seller identity and link IDs are intentionally excluded.
 *
 * Auth note: both endpoints are guarded by a simple bearer-token check against
 * TELEMETRY_TOKEN env var.  When the var is unset the routes are disabled
 * (return 404) so local dev without auth is safe.
 */
export function telemetryRoutes(c: Container): Hono {
  const app = new Hono();

  const token = process.env.TELEMETRY_TOKEN;

  function guard(ctx: Context): Response | null {
    if (!token) return ctx.json({ error: "telemetry_not_enabled" }, 404) as unknown as Response;
    const auth = ctx.req.header("authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!secureEqual(provided, token)) return ctx.json({ error: "unauthorized" }, 401) as unknown as Response;
    return null;
  }

  app.get("/summary", async (ctx) => {
    const denied = guard(ctx);
    if (denied) return denied;
    const rows = await c.telemetry.summary();
    return ctx.json({ summary: rows });
  });

  // Anonymised recent rows for the operator view's per-corridor table
  // (issue 5.21). Same guard as the rest; the row id is stripped because it
  // embeds the off-ramp job id — the export.csv column set already
  // established that no link/seller/job identifier leaves this surface.
  app.get("/rows", async (ctx) => {
    const denied = guard(ctx);
    if (denied) return denied;

    const corridor = ctx.req.query("corridor") ?? "";
    const rawLimit = Number(ctx.req.query("limit") ?? 20);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 20;

    const rows = (await c.telemetry.all())
      .filter((r) => (corridor ? r.corridor === corridor : true))
      .sort((a, b) => b.quotedAt - a.quotedAt)
      .slice(0, limit)
      .map((r) => ({
        anchorDomain: r.anchorDomain,
        corridor: r.corridor,
        sellAsset: r.sellAsset,
        sellAmount: r.sellAmount,
        quotedRate: r.quotedRate,
        effectiveRate: r.effectiveRate,
        feeAmount: r.feeAmount,
        quotedAt: r.quotedAt,
        initiatedAt: r.initiatedAt,
        settledAt: r.settledAt,
        status: r.status,
        failureReason: r.failureReason,
      }));

    return ctx.json({ rows });
  });

  app.get("/export.csv", async (ctx) => {
    const denied = guard(ctx);
    if (denied) return denied;

    const rows = await c.telemetry.all();
    const header =
      "corridor,sell_asset,sell_amount,quoted_rate,quoted_at,initiated_at,settled_at,effective_rate,fee_amount,status\n";
    const lines = rows
      .map((r) =>
        [
          r.corridor,
          r.sellAsset,
          r.sellAmount,
          r.quotedRate,
          r.quotedAt ? new Date(r.quotedAt).toISOString() : "",
          r.initiatedAt ? new Date(r.initiatedAt).toISOString() : "",
          r.settledAt ? new Date(r.settledAt).toISOString() : "",
          r.effectiveRate ?? "",
          r.feeAmount ?? "",
          r.status,
        ]
          .map(csvCell)
          .join(","),
      )
      .join("\n");

    return new Response(header + lines, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="offramp_telemetry_${datestamp()}.csv"`,
      },
    });
  });

  return app;
}

/** Constant-time string comparison — a plain `!==` on strings leaks the token
 *  length and lets an attacker time responses to recover it byte-by-byte. */
function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(ab, bb);
}

/** Wrap a CSV field in quotes if it contains commas, quotes, or newlines. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function datestamp(): string {
  return new Date().toISOString().slice(0, 10);
}
