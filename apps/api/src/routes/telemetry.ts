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
