import { WebAuth } from "@stellar/stellar-sdk";
import {
  AnchorAuthRequiredError,
  NOOP_LOGGER,
  type AnchorCustomer,
  type AnchorSession,
  type AnchorSessionRepository,
  type Logger,
} from "@checkout/core";
import { fetchStellarToml, type Sep1DiscoveryInfo } from "./sep1";

// ===========================================================================
//  Per-seller anchor identity.
// ===========================================================================
// An anchor knows a customer by the Stellar account that authenticated over
// SEP-10. This used to be one platform keypair (DEFAULT_SELLER_SECRET) for
// every seller, so every seller was the same customer at the anchor: one
// seller's KYC could overwrite another's, and withdrawals ran as the platform.
//
// Now the seller's own wallet signs the anchor's challenge, in the browser.
// Quay fetches and verifies the challenge, relays the signed transaction, and
// keeps the resulting JWT so the cash-out poller can follow the withdrawal.
// The JWT can read/update KYC and start a withdrawal; it cannot move funds.

/** Anchor-token lifetime we refuse to go below when deciding it is still live. */
const EXPIRY_SKEW_MS = 60_000;

export interface AnchorDiscoveryOptions {
  homeDomain: string;
  /** Origin the guessed endpoints hang off when SEP-1 discovery fails. */
  fallbackBaseUrl: string;
  expectedNetworkPassphrase?: string;
  logger?: Logger;
}

/** SEP-1 discovery for one anchor, shared by auth, KYC and the withdraw flow. */
export class AnchorDiscovery {
  readonly homeDomain: string;
  private readonly fallbackBaseUrl: string;
  private readonly expectedNetworkPassphrase: string | undefined;
  private readonly logger: Logger;
  private pending: Promise<Sep1DiscoveryInfo> | null = null;

  constructor(opts: AnchorDiscoveryOptions) {
    this.homeDomain = opts.homeDomain;
    this.fallbackBaseUrl = opts.fallbackBaseUrl.replace(/\/+$/, "");
    this.expectedNetworkPassphrase = opts.expectedNetworkPassphrase;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  /**
   * Resolved once and cached (sep1.ts expires its own cache after five
   * minutes). A rejected discovery is never cached as the answer.
   */
  get(): Promise<Sep1DiscoveryInfo> {
    if (!this.pending) {
      this.pending = fetchStellarToml(this.homeDomain, {
        expectedNetworkPassphrase: this.expectedNetworkPassphrase,
        logger: this.logger,
      }).then((info) =>
        info.fallback
          ? {
              ...info,
              webAuthEndpoint: `${this.fallbackBaseUrl}/auth`,
              transferServer: `${this.fallbackBaseUrl}/sep6`,
              transferServerSep24: `${this.fallbackBaseUrl}/sep24`,
              anchorQuoteServer: `${this.fallbackBaseUrl}/sep38`,
              kycServer: `${this.fallbackBaseUrl}/sep12`,
              homeDomain: this.homeDomain,
            }
          : info,
      );
      this.pending.catch(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }
}

/** The challenge failed verification, or the signed one came back for the wrong account. */
export class AnchorChallengeError extends Error {
  constructor(reason: string) {
    super(`Anchor SEP-10 challenge rejected: ${reason}`);
    this.name = "AnchorChallengeError";
  }
}

export interface SellerAnchorAuthOptions {
  discovery: AnchorDiscovery;
  /** Our network. A challenge built for any other network is refused. */
  networkPassphrase: string;
  sessions: AnchorSessionRepository;
  logger?: Logger;
}

export interface AnchorChallenge {
  /** Unsigned challenge XDR for the seller's wallet to sign. */
  transaction: string;
  networkPassphrase: string;
}

export class SellerAnchorAuth {
  private readonly discovery: AnchorDiscovery;
  private readonly sessions: AnchorSessionRepository;
  private readonly networkPassphrase: string;
  private readonly logger: Logger;

  constructor(opts: SellerAnchorAuthOptions) {
    this.discovery = opts.discovery;
    this.networkPassphrase = opts.networkPassphrase;
    this.sessions = opts.sessions;
    this.logger = (opts.logger ?? NOOP_LOGGER).child({ component: "anchor-auth", anchor: opts.discovery.homeDomain });
  }

  get anchorDomain(): string {
    return this.discovery.homeDomain;
  }

  /**
   * Fetch a SEP-10 challenge for the seller's account and verify it before it
   * goes anywhere near their wallet: issued by the anchor's published
   * SIGNING_KEY, sequence 0, current timebounds, our home domain. A wallet
   * shows the seller what they sign, but a challenge that is secretly a
   * payment must never reach that prompt in the first place.
   */
  async challenge(customer: AnchorCustomer): Promise<AnchorChallenge> {
    const d = await this.verifiableDiscovery();
    const url = new URL(d.webAuthEndpoint);
    url.searchParams.set("account", customer.account);
    url.searchParams.set("home_domain", this.anchorDomain);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SEP-10 challenge fetch failed: ${res.status} ${await res.text()}`);
    }
    const { transaction, network_passphrase } = (await res.json()) as {
      transaction: string;
      network_passphrase: string;
    };
    if (network_passphrase !== this.networkPassphrase) {
      throw new AnchorChallengeError("challenge was built for a different network");
    }
    this.verify(transaction, d, customer.account);
    return { transaction, networkPassphrase: network_passphrase };
  }

  /**
   * Relay the wallet-signed challenge and keep the JWT. The signed transaction
   * is re-verified: it must still be the anchor's challenge, and for THIS
   * seller's account — a JWT for some other account stored under this seller
   * would recreate exactly the cross-seller mix-up this class exists to end.
   */
  async complete(customer: AnchorCustomer, signedTransaction: string): Promise<{ expiresAt: number }> {
    const d = await this.verifiableDiscovery();
    this.verify(signedTransaction, d, customer.account);

    const res = await fetch(d.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: signedTransaction }),
    });
    if (!res.ok) {
      throw new AnchorChallengeError(`anchor refused the signed challenge (${res.status}): ${await res.text()}`);
    }
    const { token } = (await res.json()) as { token: string };
    const claims = decodeJwtClaims(token);
    // `sub` is the account, or `account:memo` for a shared account. Never
    // store a token the anchor issued to someone else.
    if (claims.sub && claims.sub.split(":")[0] !== customer.account) {
      throw new AnchorChallengeError("anchor issued a token for a different account");
    }
    const expiresAt = (claims.exp ?? Math.floor(Date.now() / 1000) + 300) * 1000;
    await this.sessions.save({
      sellerId: customer.sellerId,
      anchorDomain: this.anchorDomain,
      account: customer.account,
      token,
      expiresAt,
      createdAt: Date.now(),
    });
    this.logger.info(
      { event: "anchor.sep10.seller_auth.ok", sellerId: customer.sellerId, expiresAt: new Date(expiresAt).toISOString() },
      "seller authenticated to anchor",
    );
    return { expiresAt };
  }

  /**
   * The seller's live anchor JWT. Throws {@link AnchorAuthRequiredError} when
   * there is none, it has expired, or it was issued to an account that is no
   * longer this seller's wallet — only the seller can fix any of those.
   */
  async token(customer: AnchorCustomer): Promise<string> {
    const s = await this.live(customer);
    if (!s) throw new AnchorAuthRequiredError(this.anchorDomain);
    return s.token;
  }

  /** Live session expiry, or null when the seller must sign in again. */
  async sessionExpiry(customer: AnchorCustomer): Promise<number | null> {
    return (await this.live(customer))?.expiresAt ?? null;
  }

  private async live(customer: AnchorCustomer): Promise<AnchorSession | null> {
    const s = await this.sessions.get(customer.sellerId, this.anchorDomain);
    if (!s || s.account !== customer.account || s.expiresAt - EXPIRY_SKEW_MS <= Date.now()) return null;
    return s;
  }

  async signOut(sellerId: string): Promise<void> {
    await this.sessions.delete(sellerId, this.anchorDomain);
  }

  /**
   * Discovery that can vouch for a challenge. A guessed (fallback) endpoint or
   * a TOML with no SIGNING_KEY means there is nothing to check the challenge
   * against, and asking a seller to sign an unverified transaction with the
   * wallet that holds their money is not a downgrade worth offering.
   */
  private async verifiableDiscovery(): Promise<Sep1DiscoveryInfo> {
    const d = await this.discovery.get();
    if (d.fallback || !d.signingKey) {
      throw new AnchorChallengeError(
        `could not verify ${this.anchorDomain}: its stellar.toml was unreachable or declares no SIGNING_KEY`,
      );
    }
    return d;
  }

  private verify(xdr: string, d: Sep1DiscoveryInfo, account: string): void {
    let clientAccountID: string;
    try {
      ({ clientAccountID } = WebAuth.readChallengeTx(
        xdr,
        d.signingKey as string,
        this.networkPassphrase,
        this.anchorDomain,
        new URL(d.webAuthEndpoint).host,
      ));
    } catch (err) {
      throw new AnchorChallengeError(err instanceof Error ? err.message : String(err));
    }
    if (clientAccountID !== account) {
      throw new AnchorChallengeError("challenge is for a different account than the signed-in seller");
    }
  }
}

function decodeJwtClaims(token: string): { sub?: string; exp?: number } {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string; exp?: number };
  } catch {
    return {};
  }
}
