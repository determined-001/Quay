import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { publicRoutes } from "../../src/routes/public";
import { createTestContainer, type TestContainer } from "../setup";

// ---------------------------------------------------------------------------
//  GET /r/:reference — the public receipt.
//
//  The attestation block is the part that makes a receipt checkable by someone
//  who does not trust whoever is running this API, so what it contains (and
//  when it is absent) is the contract worth pinning.
// ---------------------------------------------------------------------------

const CONTRACT = "CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3";

let container: TestContainer;
let app: Hono;

beforeAll(async () => {
  container = await createTestContainer();
  app = new Hono();
  app.route("/r", publicRoutes(container));
});

afterAll(() => {
  container.client.close();
});

async function paidLink(over: Record<string, unknown> = {}) {
  const seller = await container.sellers.getDefault();
  const link = await container.links.create({
    id: `lnk_${Math.random().toString(36).slice(2, 10)}`,
    reference: `pl_${Math.random().toString(36).slice(2, 10)}`,
    sellerId: seller.id,
    destination: seller.wallet,
    muxedId: null,
    title: "Receipt test",
    amount: "10",
    asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    expiresAt: null,
  });
  Object.assign(link, { status: "paid", txHash: "tx_paid_1", payer: "GBUYER", paidAmount: "10" }, over);
  await container.links.save(link);
  return link;
}

describe("GET /r/:reference attestation block", () => {
  it("is null on a settled link that has not been attested", async () => {
    const link = await paidLink();
    const res = await app.request(`/r/${link.reference}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("paid");
    // Explicitly null rather than absent: a receipt that simply omits the field
    // is indistinguishable from an older API that never had one.
    expect(body).toHaveProperty("attestation", null);
  });

  it("carries the contract, refHash, transaction and ledger once attested", async () => {
    const link = await paidLink({
      attestationContractId: CONTRACT,
      attestationTxHash: "soroban_tx_1",
      attestationLedger: 9001,
      attestedAt: 1_700_000_500_000,
    });

    const res = await app.request(`/r/${link.reference}`);
    const body = (await res.json()) as { attestation: Record<string, unknown> };

    expect(body.attestation).toEqual({
      contractId: CONTRACT,
      // The registry is keyed by the hash, never the reference itself, so this
      // is the value a holder actually looks up. Computed independently here:
      // if the two ever diverge, every published receipt becomes unverifiable.
      refHash: createHash("sha256").update(link.reference, "utf8").digest("hex"),
      txHash: "soroban_tx_1",
      ledger: 9001,
      attestedAt: 1_700_000_500_000,
    });
  });

  it("still publishes the attestation when the writing transaction is unknown", async () => {
    // Found already present in the registry: the fact is verifiable, our
    // transaction hash is not ours to name.
    const link = await paidLink({
      attestationContractId: CONTRACT,
      attestationTxHash: null,
      attestationLedger: 9001,
      attestedAt: 1_700_000_500_000,
    });

    const res = await app.request(`/r/${link.reference}`);
    const body = (await res.json()) as { attestation: Record<string, unknown> };

    expect(body.attestation).toMatchObject({ contractId: CONTRACT, txHash: null });
  });

  it("does not leak the seller or off-ramp economics onto a public receipt", async () => {
    const link = await paidLink({ attestationContractId: CONTRACT, attestedAt: 1 });
    const res = await app.request(`/r/${link.reference}`);
    const body = (await res.json()) as Record<string, unknown>;

    for (const leak of ["sellerId", "offrampRate", "offrampFeeAmount", "offrampNetTargetAmount"]) {
      expect(body).not.toHaveProperty(leak);
    }
  });

  it("404s an unpaid link — an unpaid link is not a receipt to attest", async () => {
    const seller = await container.sellers.getDefault();
    const link = await container.links.create({
      id: "lnk_unpaid_receipt",
      reference: "pl_unpaid_receipt",
      sellerId: seller.id,
      destination: seller.wallet,
      muxedId: null,
      title: "Unpaid",
      amount: "10",
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      expiresAt: null,
    });

    const res = await app.request(`/r/${link.reference}`);
    expect(res.status).toBe(404);
  });
});
