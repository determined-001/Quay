import type { Keypair } from "@stellar/stellar-sdk";
import { KycRequiredError, type KycFieldSpec, type KycPort, type KycRecord, type KycRepository } from "@checkout/core";
import { resolveAnchor, type Logger, type ResolvedAnchor } from "./anchor";
import { Sep10Client } from "./sep10";
import { getSep12Customer, putSep12Customer } from "./sep12";

/** Non-optional fields in `required` that `values` doesn't have a non-blank
 *  entry for. Exported for direct unit testing of the "name exactly which
 *  fields are missing" requirement, without needing a live/mocked anchor. */
export function missingRequiredFields(required: KycFieldSpec[], values: Record<string, string>): string[] {
  return required.filter((f) => !f.optional && !(values[f.name] ?? "").trim()).map((f) => f.name);
}

const DEFAULT_HOME_DOMAIN = "testanchor.stellar.org";

export interface TestAnchorKycOptions {
  /** Same seller keypair used for the SEP-10/SEP-6 off-ramp adapter. */
  sellerKeypair: Keypair;
  repo: KycRepository;
  /** The anchor's home domain — the ONLY endpoint configuration needed. */
  homeDomain?: string;
  /** Expected NETWORK_PASSPHRASE; a mismatched anchor is rejected at discovery. */
  networkPassphrase?: string;
  /** Base URL for last-resort fallback paths; defaults to `https://<homeDomain>`. */
  baseUrl?: string;
  logger?: Logger;
}

/**
 * SEP-12 KYC lifecycle for the real testanchor, kept separate from a cash-out
 * request: identity is submitted once (or updated) and reused across links,
 * never re-derived from whatever happened to be in a cash-out form.
 */
export class TestAnchorKyc implements KycPort {
  private readonly repo: KycRepository;
  private readonly opts: TestAnchorKycOptions;
  private readonly homeDomain: string;
  private session: Promise<{ anchor: ResolvedAnchor; auth: Sep10Client }> | null = null;

  constructor(opts: TestAnchorKycOptions) {
    this.opts = opts;
    this.repo = opts.repo;
    this.homeDomain = opts.homeDomain ?? DEFAULT_HOME_DOMAIN;
  }

  /** Memoized SEP-1 discovery; a failure clears the memo so the next call retries. */
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

  async status(sellerId: string): Promise<KycRecord> {
    const existing = await this.repo.get(sellerId);
    const { anchor, auth } = await this.connect();
    const jwt = await auth.token();
    const remote = await getSep12Customer(anchor.kycServer, jwt, {
      account: auth.publicKey,
      customerId: existing?.customerId,
    });

    const record: KycRecord = {
      sellerId,
      customerId: remote.customerId,
      status: remote.status,
      requiredFields: remote.requiredFields,
      providedFields: existing?.providedFields ?? {},
      message: remote.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }

  async submit(sellerId: string, fields: Record<string, string>): Promise<KycRecord> {
    const existing = await this.repo.get(sellerId);
    const { anchor, auth } = await this.connect();
    const jwt = await auth.token();
    const discovery = await getSep12Customer(anchor.kycServer, jwt, {
      account: auth.publicKey,
      customerId: existing?.customerId,
    });

    const merged = { ...existing?.providedFields, ...fields };

    // Fail fast on anything we already know the anchor needs — never submit a
    // partial record and hope. If discovery hasn't happened yet (no customer
    // record at all), there's nothing to check against; the anchor's response
    // to this first PUT is what reveals the real requirements.
    const missing = missingRequiredFields(discovery.requiredFields, merged);
    if (missing.length > 0) throw new KycRequiredError(missing);

    const put = await putSep12Customer(anchor.kycServer, jwt, {
      account: auth.publicKey,
      customerId: discovery.customerId,
      fields: merged,
    });

    // The anchor may reveal more required fields only after seeing this
    // submission (SEP-12 is progressive) — re-sync rather than assume ACCEPTED.
    const after = await getSep12Customer(anchor.kycServer, jwt, {
      account: auth.publicKey,
      customerId: put.customerId,
    });

    const record: KycRecord = {
      sellerId,
      customerId: put.customerId,
      status: after.status,
      requiredFields: after.requiredFields,
      providedFields: merged,
      message: after.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }
}

/** `OFFRAMP=mock` has no real anchor and nothing to be compliant with — never
 *  gates the (simulated) cash-out path. */
export class NoKycRequired implements KycPort {
  async status(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }

  async submit(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }

  private accepted(sellerId: string): KycRecord {
    return {
      sellerId,
      customerId: null,
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    };
  }
}
