import type { Keypair } from "@stellar/stellar-sdk";
import {
  OffRampJobNotFoundError,
  type AssetRef,
  type OffRampJob,
  type OffRampJobStatus,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type OffRampStateRepository,
  type SellerPayoutRef,
} from "@checkout/core";
import { assertCurrencySupported, resolveAnchor, type Logger, type ResolvedAnchor } from "./anchor";
import { Sep10Client } from "./sep10";
import { getSep38Quote } from "./sep38";
import { getSep6Transaction, startSep6Withdraw } from "./sep6";

// ===========================================================================
//  REAL ANCHOR — SEP-10 (auth) -> SEP-38 (quote) -> SEP-6 (withdraw).
// ===========================================================================
// Talks to the public Stellar testnet reference anchor by default. Same
// `OffRampPort` contract as MockAnchorOffRamp, `seller_initiated` mode: the
// seller already holds the stablecoin, this only quotes an FX rate and drives
// a real off-chain withdrawal to local/bank rails via the anchor's SEP-6 flow.
//
// SEP-24 (interactive) was considered instead of SEP-6 and rejected: the port
// is backend-only today (no interactive-redirect concept anywhere upstream of
// this adapter), while SEP-6 is fully field-driven and needs no changes to
// LinkService, the API routes, or the dashboard.
//
// Quotes and jobs are persisted through `OffRampStateRepository` rather than
// kept in a Map — this is money-adjacent state that must survive a restart.
//
// SEP-12 KYC is deliberately NOT done here: `TestAnchorKyc` (kyc.ts) owns that
// lifecycle, keyed by seller and submitted ahead of time through /seller/kyc.
// `initiate()` assumes the caller (LinkService) already confirmed the seller's
// KYC status is ACCEPTED — this adapter has no business fabricating identity
// fields from whatever happened to be in a cash-out request.
//
// Endpoints are NOT hard-coded: `homeDomain` is the only configuration, and
// every URL comes from the anchor's SEP-1 stellar.toml (anchor.ts). That is what
// makes this class swappable to a different anchor by changing one env var
// instead of forking it.

const ANCHOR_NAME = "testanchor";
const DEFAULT_HOME_DOMAIN = "testanchor.stellar.org";

export interface TestAnchorOptions {
  /** Seller's Stellar keypair — SEP-10 needs the secret key to sign the auth challenge. */
  sellerKeypair: Keypair;
  state: OffRampStateRepository;
  /** The anchor's home domain — the ONLY endpoint configuration needed. */
  homeDomain?: string;
  /**
   * Expected NETWORK_PASSPHRASE. When set, an anchor advertising a different
   * network is rejected at discovery instead of at signing time.
   */
  networkPassphrase?: string;
  /** Base URL for last-resort fallback paths; defaults to `https://<homeDomain>`. */
  baseUrl?: string;
  logger?: Logger;
}

function mapSep6Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  return "pending"; // pending_anchor, pending_user_transfer_start, pending_external, ...
}

export class TestAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly state: OffRampStateRepository;
  private readonly opts: TestAnchorOptions;
  private readonly homeDomain: string;
  /** Memoized SEP-1 discovery + the SEP-10 client it configures. */
  private session: Promise<{ anchor: ResolvedAnchor; auth: Sep10Client }> | null = null;

  constructor(opts: TestAnchorOptions) {
    this.opts = opts;
    this.state = opts.state;
    this.homeDomain = opts.homeDomain ?? DEFAULT_HOME_DOMAIN;
  }

  /**
   * Discovery is async and network-bound, so it can't happen in the constructor.
   * Memoized on success; a failure clears the memo so the next call retries
   * rather than caching a transient DNS/network blip for the process lifetime.
   */
  private connect(): Promise<{ anchor: ResolvedAnchor; auth: Sep10Client }> {
    if (this.session) return this.session;
    const pending = (async () => {
      const anchor = await resolveAnchor(this.homeDomain, {
        baseUrl: this.opts.baseUrl,
        expectedNetworkPassphrase: this.opts.networkPassphrase,
        logger: this.opts.logger,
      });
      const auth = new Sep10Client(this.opts.sellerKeypair, {
        webAuthEndpoint: anchor.webAuthEndpoint,
        homeDomain: anchor.homeDomain,
        // No SIGNING_KEY means no way to verify a challenge; Sep10Client refuses
        // to sign rather than trusting whatever the server hands it.
        signingKey: anchor.signingKey ?? "",
        networkPassphrase: this.opts.networkPassphrase ?? anchor.networkPassphrase ?? undefined,
      });
      return { anchor, auth };
    })();
    this.session = pending.catch((err: unknown) => {
      this.session = null;
      throw err;
    });
    return this.session;
  }

  /** The seller's public key — no discovery needed. */
  get publicKey(): string {
    return this.opts.sellerKeypair.publicKey();
  }

  async quote(input: {
    linkId: string;
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    if (input.sourceAsset.issuer === null) {
      throw new Error(
        'The test anchor only off-ramps USDC — create the link with assetCode "USDC" to cash out.',
      );
    }
    const { anchor, auth } = await this.connect();

    // The anchor's own CURRENCIES list is the authority on what it will accept —
    // check before spending a SEP-10 round trip on an asset it never listed.
    assertCurrencySupported(anchor, input.sourceAsset, this.opts.logger);

    const jwt = await auth.token();
    const q = await getSep38Quote(anchor.anchorQuoteServer, jwt, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
    });

    const expiresAt = Date.parse(q.expiresAt);
    await this.state.saveQuote({
      quoteId: q.id,
      linkId: input.linkId,
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
      expiresAt,
      createdAt: Date.now(),
    });

    return {
      quoteId: q.id,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: q.buyAmount,
      rate: q.price,
      expiresAt,
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampJob> {
    const q = await this.state.getQuote(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const { anchor, auth } = await this.connect();
    assertCurrencySupported(anchor, q.sellAsset, this.opts.logger);

    const jwt = await auth.token();

    const withdraw = await startSep6Withdraw(anchor.transferServer, jwt, {
      assetCode: q.sellAsset.code,
      amount: q.sellAmount,
      account: auth.publicKey,
      type: input.payout.fields.type ?? "bank_account",
      dest: input.payout.fields.dest,
      destExtra: input.payout.fields.dest_extra,
    });

    const now = Date.now();
    await this.state.saveJob({
      jobId: withdraw.id,
      linkId: input.linkId,
      anchor: ANCHOR_NAME,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
      status: "pending",
      externalStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    return {
      jobId: withdraw.id,
      linkId: input.linkId,
      status: "pending",
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
    };
  }

  async status(jobId: string): Promise<OffRampJob> {
    const job = await this.state.getJob(jobId);
    if (!job) throw new OffRampJobNotFoundError(jobId);

    const { anchor, auth } = await this.connect();
    const jwt = await auth.token();
    const tx = await getSep6Transaction(anchor.transferServer, jwt, jobId);
    const status = mapSep6Status(tx.status);
    const targetAmount = tx.amountOut ?? job.targetAmount;
    const reason = status === "failed" ? (tx.message ?? "testanchor: withdrawal failed") : null;

    await this.state.updateJob(jobId, {
      targetAmount,
      status,
      externalStatus: tx.status,
      lastError: reason,
    });

    return {
      jobId,
      linkId: job.linkId,
      status,
      targetCurrency: job.targetCurrency,
      targetAmount,
      rate: job.rate,
      reason: reason ?? undefined,
    };
  }
}
