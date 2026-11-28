import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refundsGate } from "../src/middleware/refunds-gate";

/**
 * Issue 8.29: refunds ship behind a flag that lands before the feature, so no
 * deployment can show a half-built refund button against real money.
 *
 * env.ts validates at module load, so each case re-imports it with a fresh
 * module registry rather than reading a function. An unset variable is
 * expressed as an empty string for the same reason env-mainnet-guards.test.ts
 * does: env.ts loads .env on import and would refill a deleted one.
 */

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  process.env = saved;
  vi.resetModules();
});

async function loadRefundsEnabled(raw: string): Promise<boolean> {
  process.env.REFUNDS_ENABLED = raw;
  vi.resetModules();
  const mod = await import("../src/env");
  return mod.env.refundsEnabled;
}

describe("REFUNDS_ENABLED", () => {
  it("is off when the variable is unset", async () => {
    expect(await loadRefundsEnabled("")).toBe(false);
  });

  it.each(["0", "yes", "on", "false", "TRUE"])("is off for %j — anything but the two documented values", async (value) => {
    expect(await loadRefundsEnabled(value)).toBe(false);
  });

  it.each(["1", "true"])("is on for %j", async (value) => {
    expect(await loadRefundsEnabled(value)).toBe(true);
  });
});

describe("refundsGate", () => {
  /** Both shapes a refund route takes: the list, and submit under one refund. */
  function appWith(enabled: boolean) {
    const app = new Hono();
    app.get("/links/:id/refunds", refundsGate(enabled), (ctx) => ctx.json({ ok: true }));
    app.post("/links/:id/refunds/:refundId/submit", refundsGate(enabled), (ctx) => ctx.json({ ok: true }));
    return app;
  }

  it("answers 501 refunds_disabled on every refund route while the flag is off", async () => {
    const app = appWith(false);

    const list = await app.request("/links/lnk_1/refunds");
    expect(list.status).toBe(501);
    expect(await list.json()).toEqual({ error: "refunds_disabled" });

    const submit = await app.request("/links/lnk_1/refunds/rfd_1/submit", { method: "POST" });
    expect(submit.status).toBe(501);
    expect(await submit.json()).toEqual({ error: "refunds_disabled" });
  });

  it("lets the route run once the flag is on", async () => {
    const res = await appWith(true).request("/links/lnk_1/refunds/rfd_1/submit", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
