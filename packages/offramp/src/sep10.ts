import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

export interface Sep10Options {
  baseUrl: string;
  homeDomain: string;
}

interface CachedToken {
  token: string;
  exp: number; // epoch seconds
}

/**
 * Fetches and caches a SEP-10 web-auth JWT for one Stellar account against one
 * anchor. https://testanchor.stellar.org/auth is the reference implementation
 * of https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
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
    const challengeUrl = new URL("/auth", this.opts.baseUrl);
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

    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    if (!(tx instanceof Transaction)) {
      throw new Error("SEP-10 challenge was not a signable Transaction");
    }
    tx.sign(this.keypair);

    const authRes = await fetch(new URL("/auth", this.opts.baseUrl), {
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
