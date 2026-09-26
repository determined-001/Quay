import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { anchorCallbacksRoutes } from "../src/routes/anchor-callbacks";
import { createTestContainer, type TestContainer } from "./setup";
import { DrizzleKycRepository } from "../src/repos/index";
import type { KycRecord } from "@checkout/core";
import * as offramp from "@checkout/offramp";

describe("anchorCallbacksRoutes — SEP-12 KYC callback endpoint", () => {
  const anchorKeypair = Keypair.random();
  const anchorDomain = "anchor.example.com";
  const rawToken = "0123456789abcdef0123456789abcdef";
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const initialRecord: KycRecord = {
    sellerId: "sel_1",
    account: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    customerId: "cust_123",
    status: "PROCESSING",
    requiredFields: [],
    providedFields: { first_name: "Alice" },
    callbackTokenHash: tokenHash,
    message: null,
    lastSyncedAt: 100,
    updatedAt: 100,
  };

  function makeSignatureHeader(kp: Keypair, timestamp: number, host: string, body: string): string {
    const payload = `${timestamp}.${host}.${body}`;
    const sig = kp.sign(Buffer.from(payload, "utf8")).toString("base64");
    return `t=${timestamp}, s=${sig}`;
  }

  let fetchStellarTomlSpy: any;

  beforeEach(() => {
    fetchStellarTomlSpy = vi.spyOn(offramp, "fetchStellarToml").mockImplementation(async (domain) => {
      if (domain === anchorDomain) {
        return {
          homeDomain: anchorDomain,
          signingKey: anchorKeypair.publicKey(),
          webAuthEndpoint: "https://anchor.example.com/auth",
          transferServer: "https://anchor.example.com/sep6",
          transferServerSep24: "https://anchor.example.com/sep24",
          anchorQuoteServer: "https://anchor.example.com/sep38",
          kycServer: "https://anchor.example.com/sep12",
          networkPassphrase: null,
          currencies: ["USDC"],
          fallback: false,
        };
      }
      throw new Error("Unknown domain");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function harness() {
    const container = await createTestContainer();
    const piiKey = Buffer.alloc(32, 1);
    const kycRepo = new DrizzleKycRepository(container.db, piiKey);
    await kycRepo.save(initialRecord);

    const withKycRepo = {
      ...container,
      kycRepo,
    };

    const app = anchorCallbacksRoutes(withKycRepo as any);
    return { app, container: container as TestContainer, kycRepo };
  }

  it("updates KYC status and requiredFields on valid signed callback", async () => {
    const { app, container, kycRepo } = await harness();

    const body = JSON.stringify({
      id: "cust_123",
      status: "ACCEPTED",
      fields: {
        tax_id: { type: "string", description: "Tax ID", optional: false },
      },
      message: "Approved",
    });
    const now = Math.floor(Date.now() / 1000);
    const host = "api.example.com";
    const sigHeader = makeSignatureHeader(anchorKeypair, now, host, body);

    const res = await app.request(`/sep12/${anchorDomain}/${rawToken}`, {
      method: "POST",
      headers: {
        host,
        signature: sigHeader,
        "content-type": "application/json",
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const updated = await kycRepo.get("sel_1");
    expect(updated?.status).toBe("ACCEPTED");
    expect(updated?.message).toBe("Approved");
    expect(updated?.requiredFields).toEqual([
      { name: "tax_id", type: "string", description: "Tax ID", optional: false, choices: undefined },
    ]);

    container.client.close();
  });

  it("rejects when signature is missing", async () => {
    const { app, container } = await harness();
    const body = JSON.stringify({ id: "cust_123", status: "ACCEPTED" });

    const res = await app.request(`/sep12/${anchorDomain}/${rawToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_signature" });
    container.client.close();
  });

  it("rejects when signature is invalid", async () => {
    const { app, container } = await harness();
    const body = JSON.stringify({ id: "cust_123", status: "ACCEPTED" });
    const invalidKeypair = Keypair.random();
    const sigHeader = makeSignatureHeader(invalidKeypair, Math.floor(Date.now() / 1000), "api.example.com", body);

    const res = await app.request(`/sep12/${anchorDomain}/${rawToken}`, {
      method: "POST",
      headers: {
        host: "api.example.com",
        signature: sigHeader,
        "content-type": "application/json",
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    container.client.close();
  });

  it("returns 404 when callback token does not match any record", async () => {
    const { app, container } = await harness();
    const body = JSON.stringify({ id: "cust_123", status: "ACCEPTED" });
    const host = "api.example.com";
    const sigHeader = makeSignatureHeader(anchorKeypair, Math.floor(Date.now() / 1000), host, body);

    const res = await app.request(`/sep12/${anchorDomain}/unknown_token`, {
      method: "POST",
      headers: {
        host,
        signature: sigHeader,
        "content-type": "application/json",
      },
      body,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "invalid_callback_token" });
    container.client.close();
  });

  it("returns 400 when customer id does not match existing record", async () => {
    const { app, container } = await harness();
    const body = JSON.stringify({ id: "wrong_cust", status: "ACCEPTED" });
    const host = "api.example.com";
    const sigHeader = makeSignatureHeader(anchorKeypair, Math.floor(Date.now() / 1000), host, body);

    const res = await app.request(`/sep12/${anchorDomain}/${rawToken}`, {
      method: "POST",
      headers: {
        host,
        signature: sigHeader,
        "content-type": "application/json",
      },
      body,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "customer_id_mismatch" });
    container.client.close();
  });
});
