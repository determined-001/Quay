import { Keypair, MemoID, MemoNone, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export interface Sep10Options {
  /** SEP-10 endpoint, from the TOML's WEB_AUTH_ENDPOINT. */
  webAuthEndpoint: string;
  homeDomain: string;
  /**
   * The anchor's SIGNING_KEY from its stellar.toml. The challenge MUST carry a
   * valid signature from this key before we sign it — see `verifyChallenge`.
   */
  signingKey: string;
  /** Expected NETWORK_PASSPHRASE; the challenge must declare this network. */
  networkPassphrase?: string;
}

interface CachedToken {
  token: string;
  exp: number; // epoch seconds
}

export class Sep10ChallengeError extends Error {
  constructor(message: string) {
    super(`SEP-10 challenge rejected: ${message}`);
    this.name = "Sep10ChallengeError";
  }
}

/**
 * Fetches and caches a SEP-10 web-auth JWT for one Stellar account against one
 * anchor. https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * Endpoint and signing key both come from the anchor's SEP-1 stellar.toml — see
 * `resolveAnchor` in anchor.ts. Nothing here is anchor-specific.
 */
export class Sep10Client {
  private cached: CachedToken | null = null;

  constructor(
    private readonly keypair: Keypair,
    private readonly opts: Sep10Options,
  ) {}

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.exp - 60 > now) return this.cached.token;
    this.cached = await this.fetchToken();
    return this.cached.token;
  }

  private async fetchToken(): Promise<CachedToken> {
    const challengeUrl = new URL(this.opts.webAuthEndpoint);
    challengeUrl.searchParams.set("account", this.keypair.publicKey());
    challengeUrl.searchParams.set("home_domain", this.opts.homeDomain);

    const challengeRes = await fetch(challengeUrl);
    if (!challengeRes.ok) {
      throw new Error(`SEP-10 challenge fetch failed: ${challengeRes.status} ${await challengeRes.text()}`);
    }
    const { transaction, network_passphrase } = (await challengeRes.json()) as {
      transaction: string;
      network_passphrase: string;
    };

    // Verify BEFORE signing. A challenge is a transaction our seller keypair
    // authorizes; signing an unvalidated one hands an attacker a signature.
    const tx = verifyChallenge(transaction, network_passphrase, {
      serverAccount: this.opts.signingKey,
      clientAccount: this.keypair.publicKey(),
      homeDomain: this.opts.homeDomain,
      networkPassphrase: this.opts.networkPassphrase,
    });

    tx.sign(this.keypair);

    const authRes = await fetch(this.opts.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.toXDR() }),
    });
    if (!authRes.ok) {
      throw new Error(`SEP-10 auth submit failed: ${authRes.status} ${await authRes.text()}`);
    }
    const { token } = (await authRes.json()) as { token: string };
    return { token, exp: decodeJwtExp(token) };
  }
}

export interface VerifyChallengeParams {
  /** SIGNING_KEY from the anchor's stellar.toml. */
  serverAccount: string;
  /** Our account — the challenge's operation source must be exactly this. */
  clientAccount: string;
  homeDomain: string;
  /** When set, the challenge's declared network must match. */
  networkPassphrase?: string;
  /** Override "now" (epoch seconds) — tests only. */
  now?: number;
}

/**
 * Validates a SEP-10 challenge transaction against the SEP-10 spec's client-side
 * rules, and returns the parsed transaction ready to sign.
 *
 * Every check here exists because failing it means we'd be signing something we
 * didn't intend. In particular a challenge whose signature is missing, invalid,
 * or made by any key other than the TOML's SIGNING_KEY is rejected — otherwise
 * an attacker who can answer the /auth GET (DNS, MITM, a compromised anchor
 * host, a stale endpoint) gets our signature over a transaction of their choice.
 */
export function verifyChallenge(
  xdr: string,
  declaredNetwork: string,
  params: VerifyChallengeParams,
): Transaction {
  if (params.networkPassphrase && declaredNetwork !== params.networkPassphrase) {
    throw new Sep10ChallengeError(
      `network passphrase is "${declaredNetwork}", expected "${params.networkPassphrase}"`,
    );
  }
  if (!params.serverAccount) {
    throw new Sep10ChallengeError(
      "no SIGNING_KEY known for this anchor — refusing to sign an unverifiable challenge",
    );
  }

  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(xdr, declaredNetwork);
  } catch (err) {
    throw new Sep10ChallengeError(
      `could not decode transaction (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  // Checked outside the try so the reason isn't reported as a decode failure.
  if (!(parsed instanceof Transaction)) {
    throw new Sep10ChallengeError("got a fee-bump transaction, which is not a valid SEP-10 challenge");
  }
  const tx: Transaction = parsed;

  // Sequence number 0 — a challenge must never be submittable to the network.
  if (tx.sequence !== "0") {
    throw new Sep10ChallengeError(`sequence number is ${tx.sequence}, must be 0`);
  }
  if (tx.source !== params.serverAccount) {
    throw new Sep10ChallengeError(
      `source account is ${tx.source}, expected the anchor's SIGNING_KEY ${params.serverAccount}`,
    );
  }

  // Time bounds must exist and must currently be valid.
  const bounds = tx.timeBounds;
  if (!bounds) throw new Sep10ChallengeError("no time bounds");
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const minTime = Number(bounds.minTime);
  const maxTime = Number(bounds.maxTime);
  if (maxTime === 0) throw new Sep10ChallengeError("time bounds have no expiry (maxTime is 0)");
  // Grace window absorbs clock skew between us and the anchor.
  const GRACE_SECONDS = 5 * 60;
  if (now + GRACE_SECONDS < minTime || now - GRACE_SECONDS > maxTime) {
    throw new Sep10ChallengeError(`not valid at this time (bounds ${minTime}–${maxTime}, now ${now})`);
  }

  // A memo, if present, must be type `id` — SEP-10 permits no other kind, and a
  // memo we don't understand changes what we'd be authorizing.
  if (tx.memo.type !== MemoNone && tx.memo.type !== MemoID) {
    throw new Sep10ChallengeError(`memo is of type "${tx.memo.type}", SEP-10 allows only \`id\``);
  }

  // First operation: manageData, sourced by OUR account, keyed "<home domain> auth".
  const ops = tx.operations;
  if (ops.length === 0) throw new Sep10ChallengeError("no operations");
  const first = ops[0];
  if (!first || first.type !== "manageData") {
    throw new Sep10ChallengeError(`first operation is "${first?.type}", expected manageData`);
  }
  if (!first.source) throw new Sep10ChallengeError("first operation has no source account");
  if (first.source !== params.clientAccount) {
    throw new Sep10ChallengeError(
      `first operation is sourced by ${first.source}, not our account ${params.clientAccount} — ` +
        "this challenge was minted for someone else",
    );
  }
  if (first.name !== `${params.homeDomain} auth`) {
    throw new Sep10ChallengeError(
      `first operation key is "${first.name}", expected "${params.homeDomain} auth"`,
    );
  }
  // The nonce is 48 bytes base64-encoded => 64 characters.
  const nonce = first.value;
  if (!nonce || nonce.length !== 64) {
    throw new Sep10ChallengeError(`nonce is ${nonce?.length ?? 0} bytes, expected a 64-byte base64 value`);
  }

  // Subsequent operations must also be manageData, and may only be sourced by
  // our account or the server — never a third party we know nothing about.
  for (let i = 1; i < ops.length; i++) {
    const op = ops[i];
    if (!op || op.type !== "manageData") {
      throw new Sep10ChallengeError(`operation ${i} is "${op?.type}", expected manageData`);
    }
    if (op.source !== params.clientAccount && op.source !== params.serverAccount) {
      throw new Sep10ChallengeError(`operation ${i} is sourced by an unrecognised account ${op.source}`);
    }
    // web_auth_domain, when present, must point at the endpoint we called.
    if (op.name === "web_auth_domain" && op.source !== params.serverAccount) {
      throw new Sep10ChallengeError("web_auth_domain operation must be sourced by the server account");
    }
  }

  // The signature check — the whole point of this function.
  assertSignedByServer(tx, params.serverAccount);

  return tx;
}

/** Throws unless `tx` carries a valid signature from `serverAccount`. */
function assertSignedByServer(tx: Transaction, serverAccount: string): void {
  if (tx.signatures.length === 0) {
    throw new Sep10ChallengeError("transaction carries no signatures");
  }

  let serverKey: Keypair;
  try {
    serverKey = Keypair.fromPublicKey(serverAccount);
  } catch {
    throw new Sep10ChallengeError(`SIGNING_KEY "${serverAccount}" is not a valid Stellar public key`);
  }

  const payload = tx.hash();
  const hint = serverKey.signatureHint();
  const signed = tx.signatures.some((sig) => {
    // Hint is a cheap pre-filter; verify() is the authority.
    if (!sig.hint().equals(hint)) return false;
    try {
      return serverKey.verify(payload, sig.signature());
    } catch {
      return false;
    }
  });

  if (!signed) {
    throw new Sep10ChallengeError(
      `not signed by the anchor's SIGNING_KEY ${serverAccount} — refusing to sign it`,
    );
  }
}

function decodeJwtExp(token: string): number {
  const fallback = Math.floor(Date.now() / 1000) + 300; // 5 min if unparsable
  const payload = token.split(".")[1];
  if (!payload) return fallback;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return json.exp ?? fallback;
  } catch {
    return fallback;
  }
}
