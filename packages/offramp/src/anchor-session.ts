import { WebAuth, type Transaction } from "@stellar/stellar-sdk";
import {
  AnchorAuthRequiredError,
  NOOP_LOGGER,
  type AnchorCustomer,
  type AnchorSession,
  type AnchorSessionRepository,
  type Logger,
} from "@checkout/core";
import { fetchStellarToml, type Sep1DiscoveryInfo } from "./sep1";
import { anchorHttpError } from "./anchor-error";

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
/** Clock drift tolerated between us and the anchor when reading `iat`. */
const CLAIM_SKEW_MS = 60_000;
/** Longest session we will store, whatever `exp` claims. */
const MAX_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000;

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
              // Left null (issue 3.19/3.22): the other paths are a documented
              // fallback layout, but there is no such thing as a default SEP-38
              // endpoint. Guessing one makes a broken TOML look like an anchor
              // without SEP-38, and quotes a URL nobody published.
              anchorQuoteServer: null,
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
export type AnchorChallengeErrorKind =
  /** The challenge was built for a different Stellar network than ours. */
  | "wrong_network"
  /** The challenge or token belongs to a different account than the seller's. */
  | "wrong_account"
  /** The anchor answered the signed challenge with an error. */
  | "refused"
  /** We could not vouch for the anchor (no SIGNING_KEY / stellar.toml). */
  | "unverifiable"
  /** The challenge failed verification for any other reason. */
  | "invalid";

export class AnchorChallengeError extends Error {
  /**
   * `reason` is for server-side logs. Callers building an HTTP response should
   * branch on `kind` and use fixed text, never `message`: some reasons come from
   * the anchor's own response.
   */
  constructor(
    readonly reason: string,
    readonly kind: AnchorChallengeErrorKind = "invalid",
  ) {
    super(`Anchor SEP-10 challenge rejected: ${reason}`);
    this.name = "AnchorChallengeError";
  }
}

/**
 * Adds Quay's SEP-10 signature to an anchor challenge so anchors can attribute
 * a seller to this deployment (issue 3.12). The keypair behind it is Quay's own
 * login identity: it holds no funds, and its signature is only added to a
 * sequence-0 challenge that names our `client_domain`, a transaction that
 * cannot be submitted to the network. It is injected in this narrow shape
 * rather than as a keypair so {@link SellerAnchorAuth} never holds a secret.
 */
export interface ClientDomainSigner {
  /**
   * Public key of Quay's SEP-10 identity. Must be the source of the challenge's
   * `client_domain` operation.
   */
  readonly signingKey: string;
  /**
   * Return the challenge XDR with Quay's signature appended. The implementation
   * refuses anything that is not a verified sequence-0 challenge for our domain.
   */
  coSign(txXdr: string): string;
}

export interface SellerAnchorAuthOptions {
  discovery: AnchorDiscovery;
  /** Our network. A challenge built for any other network is refused. */
  networkPassphrase: string;
  sessions: AnchorSessionRepository;
  /**
   * Our own home domain. When set, the challenge asks the anchor for a
   * `client_domain` and {@link SellerAnchorAuth.complete} co-signs it through
   * `signClientDomain`, so the anchor can attribute the seller to Quay
   * (SEP-10 "Verifying the Client Domain"). Off when unset.
   */
  clientDomain?: string;
  /** Required with `clientDomain`. See {@link ClientDomainSigner}. */
  signClientDomain?: ClientDomainSigner;
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
  private readonly clientDomain: string | undefined;
  private readonly signClientDomain: ClientDomainSigner | undefined;
  private readonly logger: Logger;

  constructor(opts: SellerAnchorAuthOptions) {
    this.discovery = opts.discovery;
    this.networkPassphrase = opts.networkPassphrase;
    this.sessions = opts.sessions;
    this.clientDomain = opts.clientDomain;
    this.signClientDomain = opts.signClientDomain;
    // Half-configured client_domain is a boot-time mistake, not something to
    // discover halfway through a seller's login.
    if (this.clientDomain && !this.signClientDomain) {
      throw new Error("SellerAnchorAuth: clientDomain is set but signClientDomain is missing");
    }
    if (this.signClientDomain && !this.clientDomain) {
      throw new Error("SellerAnchorAuth: signClientDomain is set but clientDomain is missing");
    }
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
    // Ask the anchor to include a `client_domain` op we can co-sign, so it can
    // attribute this seller to Quay (issue 3.12). Absent by default; an anchor
    // that ignores it issues an ordinary challenge and we relay it unchanged.
    if (this.clientDomain) url.searchParams.set("client_domain", this.clientDomain);

    const res = await fetch(url);
    if (!res.ok) {
      throw await anchorHttpError("10", "challenge fetch", res);
    }
    const { transaction, network_passphrase } = (await res.json()) as {
      transaction: string;
      network_passphrase: string;
    };
    if (network_passphrase !== this.networkPassphrase) {
      throw new AnchorChallengeError("challenge was built for a different network", "wrong_network");
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
    const tx = this.verify(signedTransaction, d, customer.account);

    const res = await fetch(d.webAuthEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: this.coSignClientDomain(tx, signedTransaction) }),
    });
    if (!res.ok) {
      // The anchor's body stays out of the error (and so out of any HTTP
      // response); it is logged, truncated, for operators.
      const refusal = await anchorHttpError("10", "auth submit", res);
      this.logger?.warn(
        { event: "anchor.error", sep: refusal.sep, op: refusal.op, statusCode: refusal.status, body: refusal.body },
        "anchor refused the signed SEP-10 challenge",
      );
      throw new AnchorChallengeError(`anchor refused the signed challenge (${res.status})`, "refused");
    }
    const { token } = (await res.json()) as { token: string };
    let expiresAt: number;
    try {
      expiresAt = this.checkClaims(token, customer, d);
    } catch (err) {
      // Reason only. The token is a bearer credential for this seller's KYC.
      this.logger.warn(
        {
          event: "anchor.sep10.seller_auth.rejected",
          sellerId: customer.sellerId,
          reason: err instanceof AnchorChallengeError ? err.reason : "unexpected error validating token",
        },
        "anchor token rejected",
      );
      throw err;
    }
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
   * Sanity-check the claims of the JWT the anchor returned and return the
   * expiry (ms) to store.
   *
   * Quay cannot verify the signature: SEP-10 does not publish the anchor's JWT
   * key. So the claims are the only check available, and a token that fails any
   * of them is never stored. See SEP-10 "JWT Structure"
   * (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md).
   */
  private checkClaims(token: string, customer: AnchorCustomer, d: Sep1DiscoveryInfo): number {
    const claims = decodeJwtClaims(token);
    if (!claims) throw new AnchorChallengeError("anchor token has no readable payload");

    // `sub` must be exactly the seller's own G account. SEP-10 also allows
    // `G...:memo` (a sub-customer of a shared account) and muxed `M...`
    // accounts, but a Quay seller is always the account itself, so either form
    // means the anchor authenticated somebody other than this seller.
    // (If muxed accounts are ever supported, that belongs in a deliberate
    // change here, not in a laxer comparison.)
    if (typeof claims.sub !== "string" || claims.sub === "") {
      throw new AnchorChallengeError("anchor token has no subject");
    }
    if (claims.sub !== customer.account) {
      if (claims.sub.includes(":")) {
        throw new AnchorChallengeError("anchor issued a token for a memo sub-account, not the seller's own account", "wrong_account");
      }
      if (claims.sub.startsWith("M")) {
        throw new AnchorChallengeError("anchor issued a token for a muxed account, not the seller's own account", "wrong_account");
      }
      throw new AnchorChallengeError("anchor issued a token for a different account", "wrong_account");
    }

    // `iss` is the issuer URI, e.g. https://testanchor.stellar.org/auth. Its
    // host must be the anchor we are talking to: the host of the endpoint that
    // issued it, or the anchor's home domain.
    if (typeof claims.iss !== "string") throw new AnchorChallengeError("anchor token has no issuer");
    let issHost: string;
    try {
      issHost = new URL(claims.iss).host.toLowerCase();
    } catch {
      throw new AnchorChallengeError("anchor token issuer is not a URL");
    }
    const allowedHosts = [new URL(d.webAuthEndpoint).host, this.anchorDomain].map((h) => h.toLowerCase());
    if (!allowedHosts.includes(issHost)) {
      throw new AnchorChallengeError(`anchor token issuer host ${issHost} is not ${allowedHosts.join(" or ")}`);
    }

    // Optional SEP-10 `home_domain` claim: when the anchor states one, it has to be ours.
    if (claims.home_domain !== undefined && String(claims.home_domain).toLowerCase() !== this.anchorDomain.toLowerCase()) {
      throw new AnchorChallengeError("anchor token was issued for a different home domain");
    }

    const now = Date.now();
    if (claims.iat !== undefined) {
      if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) {
        throw new AnchorChallengeError("anchor token iat is not a number");
      }
      if (claims.iat * 1000 > now + CLAIM_SKEW_MS) throw new AnchorChallengeError("anchor token was issued in the future");
    }
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
      throw new AnchorChallengeError("anchor token has no expiry");
    }
    if (claims.exp * 1000 <= now) throw new AnchorChallengeError("anchor token has already expired");
    // Do not trust a far-future expiry: a session that lives for years would
    // outlast anything the seller consented to. Cap it instead of refusing.
    return Math.min(claims.exp * 1000, now + MAX_TOKEN_LIFETIME_MS);
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
        "unverifiable",
      );
    }
    return d;
  }

  private verify(xdr: string, d: Sep1DiscoveryInfo, account: string): Transaction {
    let clientAccountID: string;
    let tx: Transaction;
    try {
      ({ clientAccountID, tx } = WebAuth.readChallengeTx(
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
      throw new AnchorChallengeError("challenge is for a different account than the signed-in seller", "wrong_account");
    }
    this.assertClientDomain(tx);
    return tx;
  }

  /**
   * The SDK tolerates a `client_domain` operation without checking who sourced
   * it or what domain it names, because it does not know which client asked. We
   * do: if the anchor echoed our `client_domain`, it must be exactly one op,
   * sourced by our signing key, naming our domain. A challenge that claims a
   * client_domain we did not ask for is refused rather than co-signed.
   */
  private assertClientDomain(tx: Transaction): void {
    const clientDomainOps = tx.operations.filter((op) => op.type === "manageData" && op.name === "client_domain");
    if (clientDomainOps.length === 0) return;
    if (clientDomainOps.length > 1) {
      throw new AnchorChallengeError("challenge has more than one client_domain operation");
    }
    if (!this.clientDomain || !this.signClientDomain) {
      throw new AnchorChallengeError("challenge claims a client_domain we did not ask for");
    }
    const op = clientDomainOps[0]!;
    if (op.type !== "manageData") return; // The filter guarantees this; narrows the type.
    if (op.source !== this.signClientDomain.signingKey) {
      throw new AnchorChallengeError("client_domain operation is not sourced by Quay's signing key");
    }
    if (op.value?.toString("utf8") !== this.clientDomain) {
      throw new AnchorChallengeError("client_domain operation names a domain that is not ours");
    }
  }

  /**
   * Add Quay's signature so the anchor can attribute the seller to Quay. Only
   * when we asked for a `client_domain` and the anchor included the op: an extra
   * signature the anchor is not expecting is rejected as unrecognized.
   */
  private coSignClientDomain(tx: Transaction, signedTransaction: string): string {
    if (!this.clientDomain || !this.signClientDomain) return signedTransaction;
    const hasOp = tx.operations.some((op) => op.type === "manageData" && op.name === "client_domain");
    if (!hasOp) return signedTransaction;
    return this.signClientDomain.coSign(signedTransaction);
  }
}

interface JwtClaims {
  iss?: unknown;
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
  home_domain?: unknown;
}

/** The payload of a three-part JWT as an object, or null when it is anything else. */
function decodeJwtClaims(token: unknown): JwtClaims | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? (claims as JwtClaims) : null;
  } catch {
    return null;
  }
}
