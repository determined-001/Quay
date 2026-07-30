import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sep10Client, Sep10ChallengeError, verifyChallenge } from "../src/sep10";

// The whole attack surface of SEP-10 is that a challenge is a transaction we
// sign with the seller's key. If we sign whatever the server hands us, anyone who
// can answer the /auth GET — DNS hijack, MITM, a compromised or impersonated
// anchor host — gets our signature over a transaction of their choosing. These
// tests pin the rejections that prevent that.

const TESTNET = Networks.TESTNET;
const WEB_AUTH = "https://testanchor.stellar.org/auth";
const HOME_DOMAIN = "testanchor.stellar.org";

const serverKey = Keypair.random(); // the anchor's stellar.toml SIGNING_KEY
const attackerKey = Keypair.random(); // any other key
const clientKey = Keypair.random(); // our seller

/** Builds a spec-shaped SEP-10 challenge, signed by `signer` unless told not to. */
function buildChallenge(
  opts: {
    signer?: Keypair | null;
    source?: string;
    clientAccount?: string;
    homeDomain?: string;
    sequence?: string;
    nonce?: string;
    minTime?: number;
    maxTime?: number;
    extraOps?: Array<{ name: string; source: string }>;
    /** Swap the first manageData op for a payment — not a valid SEP-10 challenge. */
    paymentInsteadOfManageData?: boolean;
    memo?: Memo;
  } = {},
): string {
  const source = opts.source ?? serverKey.publicKey();
  const clientAccount = opts.clientAccount ?? clientKey.publicKey();
  const now = Math.floor(Date.now() / 1000);
  // SEP-10 nonce: 48 random bytes, base64-encoded => exactly 64 characters.
  const nonce = opts.nonce ?? randomBytes(48).toString("base64");

  const builder = new TransactionBuilder(new Account(source, opts.sequence ?? "-1"), {
    fee: "100",
    networkPassphrase: TESTNET,
    timebounds: { minTime: opts.minTime ?? now - 60, maxTime: opts.maxTime ?? now + 600 },
  });

  if (opts.paymentInsteadOfManageData) {
    builder.addOperation(
      Operation.payment({
        source: clientAccount,
        destination: serverKey.publicKey(),
        asset: Asset.native(),
        amount: "100",
      }),
    );
  } else {
    builder.addOperation(
      Operation.manageData({
        source: clientAccount,
        name: `${opts.homeDomain ?? HOME_DOMAIN} auth`,
        value: nonce,
      }),
    );
  }

  for (const extra of opts.extraOps ?? []) {
    builder.addOperation(Operation.manageData({ source: extra.source, name: extra.name, value: "x" }));
  }

  if (opts.memo) builder.addMemo(opts.memo);

  const tx = builder.build();
  const signer = opts.signer === undefined ? serverKey : opts.signer;
  if (signer) tx.sign(signer);
  return tx.toXDR();
}

const baseParams = {
  serverAccount: serverKey.publicKey(),
  clientAccount: clientKey.publicKey(),
  homeDomain: HOME_DOMAIN,
  networkPassphrase: TESTNET,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyChallenge — signature provenance", () => {
  it("accepts a well-formed challenge signed by the TOML's SIGNING_KEY", () => {
    const tx = verifyChallenge(buildChallenge(), TESTNET, baseParams);
    expect(tx.source).toBe(serverKey.publicKey());
    expect(tx.sequence).toBe("0");
  });

  it("REJECTS a challenge signed by an unexpected key before we sign it", () => {
    // The acceptance criterion: valid in every other respect, wrong signer.
    expect(() => verifyChallenge(buildChallenge({ signer: attackerKey }), TESTNET, baseParams)).toThrow(
      Sep10ChallengeError,
    );
    expect(() => verifyChallenge(buildChallenge({ signer: attackerKey }), TESTNET, baseParams)).toThrow(
      /not signed by the anchor's SIGNING_KEY/,
    );
  });

  it("REJECTS a challenge carrying no signature at all", () => {
    expect(() => verifyChallenge(buildChallenge({ signer: null }), TESTNET, baseParams)).toThrow(
      /no signatures/,
    );
  });

  it("REJECTS a challenge whose source account is not the SIGNING_KEY", () => {
    // An attacker's own account as source, signed correctly by that account —
    // the signature is valid, it's just not the anchor's.
    const xdr = buildChallenge({ source: attackerKey.publicKey(), signer: attackerKey });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/expected the anchor's SIGNING_KEY/);
  });

  it("refuses to verify at all when no SIGNING_KEY is known for the anchor", () => {
    // An anchor with no SIGNING_KEY in its TOML is unverifiable; that must fail
    // closed, never degrade to "sign it anyway".
    expect(() => verifyChallenge(buildChallenge(), TESTNET, { ...baseParams, serverAccount: "" })).toThrow(
      /refusing to sign an unverifiable challenge/,
    );
  });

  it("REJECTS a malformed SIGNING_KEY rather than treating it as absent", () => {
    expect(() =>
      verifyChallenge(buildChallenge(), TESTNET, { ...baseParams, serverAccount: "not-a-key" }),
    ).toThrow(/not a valid Stellar public key/);
  });
});

describe("verifyChallenge — transaction shape", () => {
  it("REJECTS a non-zero sequence number (a submittable transaction, not a challenge)", () => {
    // The builder increments the account's sequence, so "41" yields 42. A real
    // challenge is built from an account at "-1", giving sequence 0.
    const xdr = buildChallenge({ sequence: "41" });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/must be 0/);
  });

  it("REJECTS a challenge minted for a different client account", () => {
    const someoneElse = Keypair.random().publicKey();
    const xdr = buildChallenge({ clientAccount: someoneElse });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/minted for someone else/);
  });

  it("REJECTS a manageData key naming a different home domain", () => {
    const xdr = buildChallenge({ homeDomain: "evil.example" });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/expected "testanchor.stellar.org auth"/);
  });

  it("REJECTS a challenge declaring the wrong network", () => {
    expect(() => verifyChallenge(buildChallenge(), Networks.PUBLIC, baseParams)).toThrow(
      /network passphrase/,
    );
  });

  it("REJECTS an expired challenge and one not yet valid", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = buildChallenge({ minTime: now - 7200, maxTime: now - 3600 });
    expect(() => verifyChallenge(expired, TESTNET, baseParams)).toThrow(/not valid at this time/);

    const future = buildChallenge({ minTime: now + 3600, maxTime: now + 7200 });
    expect(() => verifyChallenge(future, TESTNET, baseParams)).toThrow(/not valid at this time/);
  });

  it("REJECTS time bounds with no expiry", () => {
    const xdr = buildChallenge({ minTime: 0, maxTime: 0 });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/no expiry/);
  });

  it("tolerates modest clock skew inside the grace window", () => {
    const now = Math.floor(Date.now() / 1000);
    // Anchor's clock is 2 minutes ahead of ours; still within the 5-min grace.
    const xdr = buildChallenge({ minTime: now + 120, maxTime: now + 900 });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).not.toThrow();
  });

  it("REJECTS a nonce that is not 64 base64 characters", () => {
    const xdr = buildChallenge({ nonce: "too-short" });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/expected a 64-byte base64 value/);
  });

  it("REJECTS an extra operation sourced by an unrecognised third party", () => {
    const stranger = Keypair.random().publicKey();
    const xdr = buildChallenge({ extraOps: [{ name: "client_domain", source: stranger }] });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/unrecognised account/);
  });

  it("allows extra manageData operations sourced by us or the server", () => {
    const xdr = buildChallenge({
      extraOps: [{ name: "web_auth_domain", source: serverKey.publicKey() }],
    });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).not.toThrow();
  });

  it("REJECTS a memo of any type other than `id`, and allows one of type `id`", () => {
    const withText = buildChallenge({ memo: Memo.text("hello") });
    expect(() => verifyChallenge(withText, TESTNET, baseParams)).toThrow(/SEP-10 allows only/);

    const withId = buildChallenge({ memo: Memo.id("12345") });
    expect(() => verifyChallenge(withId, TESTNET, baseParams)).not.toThrow();
  });

  it("REJECTS a challenge whose first operation is a payment, not manageData", () => {
    // The nightmare case: a real payment operation sourced by our account,
    // correctly signed by the anchor. Signing this moves money.
    const xdr = buildChallenge({ paymentInsteadOfManageData: true });
    expect(() => verifyChallenge(xdr, TESTNET, baseParams)).toThrow(/expected manageData/);
  });

  it("REJECTS undecodable XDR with a typed error instead of a raw parse crash", () => {
    expect(() => verifyChallenge("not-xdr-at-all", TESTNET, baseParams)).toThrow(Sep10ChallengeError);
    expect(() => verifyChallenge("not-xdr-at-all", TESTNET, baseParams)).toThrow(/could not decode/);
  });
});

describe("Sep10Client", () => {
  it("never POSTs a signed transaction when the challenge fails verification", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("must not submit an unverified challenge");
      return new Response(
        JSON.stringify({
          // Signed by an attacker, not the anchor's SIGNING_KEY.
          transaction: buildChallenge({ signer: attackerKey }),
          network_passphrase: TESTNET,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Sep10Client(clientKey, {
      webAuthEndpoint: WEB_AUTH,
      homeDomain: HOME_DOMAIN,
      signingKey: serverKey.publicKey(),
      networkPassphrase: TESTNET,
    });

    await expect(client.token()).rejects.toThrow(/not signed by the anchor's SIGNING_KEY/);
    // Exactly one call — the GET. No POST ever happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBeUndefined();
  });

  it("signs and submits a valid challenge, then caches the JWT", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

    let submitted: Transaction | null = null;
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { transaction: string };
        submitted = TransactionBuilder.fromXDR(body.transaction, TESTNET) as Transaction;
        return new Response(JSON.stringify({ token: jwt }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ transaction: buildChallenge(), network_passphrase: TESTNET }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Sep10Client(clientKey, {
      webAuthEndpoint: WEB_AUTH,
      homeDomain: HOME_DOMAIN,
      signingKey: serverKey.publicKey(),
      networkPassphrase: TESTNET,
    });

    expect(await client.token()).toBe(jwt);
    // Our signature was added alongside the anchor's, not in place of it.
    expect(submitted).not.toBeNull();
    expect((submitted as unknown as Transaction).signatures).toHaveLength(2);

    // Second call is served from cache — no further HTTP.
    expect(await client.token()).toBe(jwt);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one GET + one POST, total
  });

  it("uses the discovered WEB_AUTH_ENDPOINT verbatim, including its path", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new Sep10Client(clientKey, {
      // A path-prefixed endpoint, as a real anchor may well publish.
      webAuthEndpoint: "https://anchor.example/api/v2/web_auth",
      homeDomain: "anchor.example",
      signingKey: serverKey.publicKey(),
    });

    await expect(client.token()).rejects.toThrow(/503/);
    const called = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(called).toContain("https://anchor.example/api/v2/web_auth");
    expect(called).toContain(`account=${clientKey.publicKey()}`);
  });
});
