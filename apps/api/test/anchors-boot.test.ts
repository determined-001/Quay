import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue 3.21: a deployment configured the old way (one anchor in the env) boots,
 * seeds exactly one `anchors` row from it, and keeps working; later boots read the
 * table rather than the env. env.ts is read at import, so each boot re-imports it.
 */
let saved: NodeJS.ProcessEnv;
let dir: string;

beforeEach(() => {
  saved = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "quay-anchors-"));
  // No anchor is reachable: boot must not depend on one.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
});

afterEach(() => {
  process.env = saved;
  vi.unstubAllGlobals();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

function useEnv(over: Record<string, string>) {
  Object.assign(process.env, {
    STELLAR_NETWORK: "testnet",
    DATABASE_URL: `file:${join(dir, "quay.db")}`,
    KYC_ENCRYPTION_KEY: "0".repeat(64),
    WEBHOOK_SECRET_ENCRYPTION_KEY: "1".repeat(64),
    ...over,
  });
}

async function boot() {
  vi.resetModules();
  const { createContainer } = await import("../src/services/container");
  return createContainer();
}

describe("anchors table at boot", () => {
  it("seeds one row from a single-anchor env, keeps the env anchor as the default, and does not reseed", async () => {
    useEnv({
      OFFRAMP: "anchor",
      ANCHOR_URL: "https://anchor.example",
      ANCHOR_HOME_DOMAIN: "anchor.example",
      OFFRAMP_PROTOCOL: "sep24",
      OFFRAMP_TYPE: "bank_account",
    });

    const first = await boot();
    const rows = await first.anchors!.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      homeDomain: "anchor.example",
      baseUrl: "https://anchor.example",
      enabled: true,
      protocol: "sep24",
      withdrawType: "bank_account",
      corridors: [],
    });
    expect(first.anchorDomain).toBe("anchor.example");
    expect(first.anchorAuth?.anchorDomain).toBe("anchor.example");
    // Any payout currency still routes to it, exactly as the single-anchor deployment did.
    expect((await first.anchors!.forCurrency("NGN"))?.domain).toBe("anchor.example");
    await first.stop();

    // Second boot: the env now disagrees, but the table is the source of truth.
    process.env.OFFRAMP_PROTOCOL = "sep6";
    const second = await boot();
    const again = await second.anchors!.list();
    expect(again).toHaveLength(1);
    expect(again[0]!.protocol).toBe("sep24");
    expect(again[0]!.id).toBe(rows[0]!.id);
    await second.stop();
  });

  it("OFFRAMP=mock has no anchors table rows and no registry, as before", async () => {
    useEnv({ OFFRAMP: "mock" });
    const c = await boot();
    expect(c.anchors).toBeNull();
    expect(c.anchorDomain).toBeNull();
    expect(c.anchorAuth).toBeNull();
    await c.stop();
  });

  it("OFFRAMP=none has no registry either", async () => {
    useEnv({ OFFRAMP: "none" });
    const c = await boot();
    expect(c.anchors).toBeNull();
    await c.stop();
  });
});
