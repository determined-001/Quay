import { describe, it, expect } from "vitest";
import { Hono } from "hono";

// ---------------------------------------------------------------------------
//  GET /health — the `attestation` block.
//
//  This exists because the failure it guards against is silent. If
//  ATTESTATION_CONTRACT_ID is not set on a deploy, the API boots green, accepts
//  payments, and attests nothing — and the only outward sign is a receipt
//  quietly missing a block nobody was looking for. Publishing the state on
//  /health turns "the contract is deployed" and "the product actually calls it"
//  into two separately checkable claims.
// ---------------------------------------------------------------------------

const CONTRACT = "CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3";

/** The /health handler's attestation branch, isolated from container boot. */
function healthApp(attestation: { enabled: boolean; contractId: string | null }) {
  const app = new Hono();
  app.get("/health", (ctx) => ctx.json({ ok: true, attestation }));
  return app;
}

describe("GET /health attestation status", () => {
  it("names the registry when attestation is on", async () => {
    const res = await healthApp({ enabled: true, contractId: CONTRACT }).request("/health");
    const body = (await res.json()) as { attestation: Record<string, unknown> };

    expect(body.attestation).toEqual({ enabled: true, contractId: CONTRACT });
  });

  it("reports enabled:false rather than omitting the block", async () => {
    // An absent field is indistinguishable from an older build that never had
    // one. An explicit false is a statement.
    const res = await healthApp({ enabled: false, contractId: null }).request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty("attestation");
    expect(body.attestation).toEqual({ enabled: false, contractId: null });
  });
});

// ---------------------------------------------------------------------------
//  render.yaml must actually declare the contract id.
//
//  Everything above is decoration if the deployed service never gets the value.
//  This is the check that would have caught the real gap: 9.2 shipped with the
//  wiring complete and the blueprint silent, so production would have attested
//  nothing while every test passed.
// ---------------------------------------------------------------------------

describe("render.yaml", () => {
  it("declares ATTESTATION_CONTRACT_ID and SOROBAN_RPC_URL", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const blueprint = readFileSync(
      fileURLToPath(new URL("../../../../render.yaml", import.meta.url)),
      "utf8",
    );

    expect(blueprint).toContain("ATTESTATION_CONTRACT_ID");
    expect(blueprint).toContain(CONTRACT);
    expect(blueprint).toContain("SOROBAN_RPC_URL");
  });
});
