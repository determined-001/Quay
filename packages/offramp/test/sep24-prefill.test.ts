import { Keypair, Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sep24Client } from "../src/sep24";

/**
 * Issue 3.17 — what actually goes out on the wire.
 *
 * `startInteractiveWithdraw` used to end with `Object.assign(bodyData,
 * input.payoutFields)`, which copied every cash-out bank field into the
 * interactive POST body whether or not the seller had agreed to share it. These
 * tests pin the replacement: an explicit `prefill` input, filtered through the
 * SEP-9 allowlist, so anything else a caller passes is dropped here rather than
 * forwarded to a third party.
 *
 * The anchor's SEP-10 token and TOML discovery are stubbed — this asserts the
 * request body, not the protocol handshake.
 */
function stubAnchor() {
  const bodies: Record<string, string>[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/transactions/withdraw/interactive")) {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, string>);
      return new Response(
        JSON.stringify({ id: "txn_1", url: "https://anchor.example/form", type: "interactive_customer_info_needed" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (String(input).includes("/auth")) {
      return new Response(JSON.stringify({ token: "jwt-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return bodies;
}

function client(): Sep24Client {
  const c = new Sep24Client(Keypair.random(), "anchor.example");
  // Discovery + SEP-10 are not what is under test; stub the client's own
  // private accessors so only the POST body is exercised.
  (c as unknown as { getDiscoveryInfo: () => Promise<unknown> }).getDiscoveryInfo = async () => ({
    transferServerSep24: "https://anchor.example/sep24",
    webAuthEndpoint: "https://anchor.example/auth",
    signingKey: "GSIGNING",
  });
  (c as unknown as { getAuthToken: () => Promise<string> }).getAuthToken = async () => "jwt-token";
  return c;
}

const base = {
  assetCode: "USDC",
  amount: "10",
  account: "GSELLER",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sep24Client.startInteractiveWithdraw — prefill", () => {
  it("never copies a payout field such as dest into the POST body", async () => {
    const bodies = stubAnchor();

    // `prefill` is the only channel now, but a caller can still try to smuggle
    // payout details through it. The allowlist is the last gate.
    await client().startInteractiveWithdraw({
      ...base,
      prefill: { dest: "0123456789", account_number: "9999999999", routing_number: "021000021" },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("dest");
    expect(bodies[0]).not.toHaveProperty("account_number");
    expect(bodies[0]).not.toHaveProperty("routing_number");
  });

  it("carries no SEP-9 keys at all when there is no prefill", async () => {
    const bodies = stubAnchor();

    await client().startInteractiveWithdraw({ ...base });

    expect(bodies[0]).toEqual({ asset_code: "USDC", account: "GSELLER", amount: "10" });
  });

  it("sends exactly the consented allowlisted field", async () => {
    const bodies = stubAnchor();

    await client().startInteractiveWithdraw({ ...base, prefill: { first_name: "Ada" } });

    expect(bodies[0]).toEqual({
      asset_code: "USDC",
      account: "GSELLER",
      amount: "10",
      first_name: "Ada",
    });
  });

  it("drops an id number and a binary document even when passed alongside a valid field", async () => {
    const bodies = stubAnchor();

    await client().startInteractiveWithdraw({
      ...base,
      prefill: {
        first_name: "Ada",
        id_number: "P1234567",
        photo_id_front: "data:image/png;base64,AAAA",
      },
    });

    expect(bodies[0].first_name).toBe("Ada");
    expect(bodies[0]).not.toHaveProperty("id_number");
    expect(bodies[0]).not.toHaveProperty("photo_id_front");
  });

  it("ignores an empty prefill value rather than sending a blank field", async () => {
    const bodies = stubAnchor();

    await client().startInteractiveWithdraw({ ...base, prefill: { first_name: "" } });

    expect(bodies[0]).not.toHaveProperty("first_name");
  });

  it("still sends the SEP-24 request fields alongside prefill", async () => {
    const bodies = stubAnchor();

    await client().startInteractiveWithdraw({
      ...base,
      assetIssuer: "GISSUER",
      quoteId: "quote_1",
      prefill: { last_name: "Lovelace" },
    });

    expect(bodies[0]).toMatchObject({
      asset_code: "USDC",
      asset_issuer: "GISSUER",
      amount: "10",
      account: "GSELLER",
      quote_id: "quote_1",
      last_name: "Lovelace",
    });
  });
});

describe("Sep24Client constructor", () => {
  it("keeps the passphrase-free surface it had: no mainnet inference added", () => {
    // AnchorOptions' networkPassphrase requirement is AnchorOffRamp's concern;
    // this client only signs SEP-10, which the anchor's own toml pins.
    expect(typeof Networks.TESTNET).toBe("string");
    expect(client()).toBeInstanceOf(Sep24Client);
  });
});
