import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";
import { Sep10Client, Sep10ChallengeRejectedError } from "../src/sep10";

// ---------------------------------------------------------------------------
// Issue #14, item 3: "Verify the SEP-10 challenge is signed by the TOML's
// SIGNING_KEY before signing it — today we sign whatever the server hands us,
// which is the whole attack surface of SEP-10."
//
// These drive a real challenge built with the SDK, so the assertions are about
// SEP-10 semantics rather than about a hand-rolled fixture.
// ---------------------------------------------------------------------------

const HOME_DOMAIN = "anchor.example";
const WEB_AUTH = "https://anchor.example/auth";

const anchorKey = Keypair.random();
const impostorKey = Keypair.random();
const sellerKey = Keypair.random();

function challengeFrom(signer: Keypair): string {
  return WebAuth.buildChallengeTx(
    signer,
    sellerKey.publicKey(),
    HOME_DOMAIN,
    300,
    Networks.TESTNET,
    "anchor.example",
  );
}

/**
 * A throwaway JWT with a far-future `exp`, assembled at runtime.
 *
 * Built rather than written as a literal on purpose: a hardcoded `a.b.c` string
 * trips the gitleaks generic-api-key rule, and the right answer to a scanner
 * flagging a fake credential is to stop writing something that looks like one,
 * not to add an allowlist entry that also covers the real thing.
 */
const FAKE_JWT = ["header", Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString("base64url"), "sig"].join(".");

/** A stub anchor that serves `challenge` and then hands back a JWT. */
function stubAnchor(challenge: string) {
  const posted: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(init.body as string).transaction as string);
      return new Response(JSON.stringify({ token: FAKE_JWT }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ transaction: challenge, network_passphrase: Networks.TESTNET }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posted };
}

describe("Sep10Client challenge verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("signs a challenge genuinely issued by the anchor's SIGNING_KEY", async () => {
    const { posted } = stubAnchor(challengeFrom(anchorKey));
    const client = new Sep10Client(sellerKey, {
      baseUrl: WEB_AUTH,
      homeDomain: HOME_DOMAIN,
      signingKey: anchorKey.publicKey(),
    });

    await expect(client.token()).resolves.toBeTruthy();
    expect(posted).toHaveLength(1);
  });

  it("refuses a challenge signed by anyone else, and never signs it", async () => {
    // The attack: something between us and the anchor returns its own
    // transaction. Without verification we would sign it with the seller's key.
    const { posted } = stubAnchor(challengeFrom(impostorKey));
    const client = new Sep10Client(sellerKey, {
      baseUrl: WEB_AUTH,
      homeDomain: HOME_DOMAIN,
      signingKey: anchorKey.publicKey(),
    });

    await expect(client.token()).rejects.toBeInstanceOf(Sep10ChallengeRejectedError);
    // The decisive assertion: nothing was ever submitted, so the seller's
    // signature never left this process.
    expect(posted).toHaveLength(0);
  });

  it("refuses a challenge for a different home domain", async () => {
    const wrongDomain = WebAuth.buildChallengeTx(
      anchorKey,
      sellerKey.publicKey(),
      "evil.example",
      300,
      Networks.TESTNET,
      "evil.example",
    );
    const { posted } = stubAnchor(wrongDomain);
    const client = new Sep10Client(sellerKey, {
      baseUrl: WEB_AUTH,
      homeDomain: HOME_DOMAIN,
      signingKey: anchorKey.publicKey(),
    });

    await expect(client.token()).rejects.toBeInstanceOf(Sep10ChallengeRejectedError);
    expect(posted).toHaveLength(0);
  });

  it("still signs when no signing key is known, since that is the pre-discovery behaviour", async () => {
    // Reachable when SEP-1 discovery failed or the anchor omits SIGNING_KEY.
    // It is a downgrade, logged as one — but refusing outright would take the
    // off-ramp down for anchors that have always worked.
    const { posted } = stubAnchor(challengeFrom(impostorKey));
    const client = new Sep10Client(sellerKey, { baseUrl: WEB_AUTH, homeDomain: HOME_DOMAIN });

    await expect(client.token()).resolves.toBeTruthy();
    expect(posted).toHaveLength(1);
  });
});
