import { createHash, randomBytes } from "node:crypto";
import {
  KycRequiredError,
  NOOP_LOGGER,
  type AnchorCustomer,
  type KycFieldSpec,
  type KycPort,
  type KycRecord,
  type KycRepository,
  type Logger,
} from "@checkout/core";
import type { AnchorDiscovery, SellerAnchorAuth } from "./anchor-session";
import { getSep12Customer, putSep12Callback, putSep12Customer } from "./sep12";

/** Non-optional fields in `required` that `values` doesn't have a non-blank
 *  entry for. Exported for direct unit testing of the "name exactly which
 *  fields are missing" requirement, without needing a live/mocked anchor. */
export function missingRequiredFields(required: KycFieldSpec[], values: Record<string, string>): string[] {
  return required.filter((f) => !f.optional && !(values[f.name] ?? "").trim()).map((f) => f.name);
}

export interface TestAnchorKycOptions {
  discovery: AnchorDiscovery;
  /** The seller's own SEP-10 session with the anchor — never a platform key. */
  auth: SellerAnchorAuth;
  repo: KycRepository;
  /** Optional public API base URL (e.g. https://api.example.com) for registering SEP-12 callback. */
  callbackBaseUrl?: string;
  logger?: Logger;
}

/**
 * SEP-12 KYC lifecycle against a real anchor, kept separate from a cash-out
 * request: identity is submitted once (or updated) and reused across links,
 * never re-derived from whatever happened to be in a cash-out form.
 *
 * The anchor's customer is the seller's own account, authenticated by the
 * seller's own wallet. Values already on file are reused (the seller's
 * reusable profile); the anchor still decides what it needs and whether it
 * accepts them.
 */
export class TestAnchorKyc implements KycPort {
  private readonly discovery: AnchorDiscovery;
  private readonly auth: SellerAnchorAuth;
  private readonly repo: KycRepository;
  private readonly callbackBaseUrl?: string;
  private readonly logger: Logger;

  constructor(opts: TestAnchorKycOptions) {
    this.discovery = opts.discovery;
    this.auth = opts.auth;
    this.repo = opts.repo;
    this.callbackBaseUrl = opts.callbackBaseUrl;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  private async registerCallbackIfConfigured(
    kycServer: string,
    jwt: string,
    customerId: string | null,
    sellerId: string,
    existingTokenHash?: string | null,
  ): Promise<string | null> {
    if (!this.callbackBaseUrl) return existingTokenHash ?? null;

    // Skip localhost and log reason
    if (
      this.callbackBaseUrl.includes("localhost") ||
      this.callbackBaseUrl.includes("127.0.0.1") ||
      this.callbackBaseUrl.startsWith("http://localhost")
    ) {
      this.logger.info(
        { sellerId, callbackBaseUrl: this.callbackBaseUrl },
        "Skipping SEP-12 callback registration for localhost origin",
      );
      return existingTokenHash ?? null;
    }

    try {
      const token = randomBytes(24).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const url = `${this.callbackBaseUrl.replace(/\/$/, "")}/anchor-callbacks/sep12/${this.discovery.homeDomain}/${token}`;

      await putSep12Callback(kycServer, jwt, { customerId, url });
      this.logger.info({ sellerId, customerId }, "Registered SEP-12 KYC callback with anchor");
      return tokenHash;
    } catch (err) {
      this.logger.warn({ sellerId, err }, "Failed to register SEP-12 KYC callback with anchor");
      return existingTokenHash ?? null;
    }
  }

  async status(customer: AnchorCustomer): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const remote = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer),
    });

    let callbackTokenHash = existing?.callbackTokenHash ?? null;
    if (remote.customerId && !callbackTokenHash) {
      callbackTokenHash = await this.registerCallbackIfConfigured(
        kycServer,
        jwt,
        remote.customerId,
        customer.sellerId,
        callbackTokenHash,
      );
    }

    const record: KycRecord = {
      sellerId: customer.sellerId,
      account: customer.account,
      customerId: remote.customerId,
      status: remote.status,
      requiredFields: remote.requiredFields,
      providedFields: existing?.providedFields ?? {},
      callbackTokenHash,
      message: remote.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }

  async submit(customer: AnchorCustomer, fields: Record<string, string>): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const discovery = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer),
    });

    const merged = { ...existing?.providedFields, ...fields };

    // Fail fast on anything we already know the anchor needs — never submit a
    // partial record and hope. If discovery hasn't happened yet (no customer
    // record at all), there's nothing to check against; the anchor's response
    // to this first PUT is what reveals the real requirements.
    const missing = missingRequiredFields(discovery.requiredFields, merged);
    if (missing.length > 0) throw new KycRequiredError(missing);

    const put = await putSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: discovery.customerId,
      fields: merged,
    });

    // The anchor may reveal more required fields only after seeing this
    // submission (SEP-12 is progressive) — re-sync rather than assume ACCEPTED.
    const after = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: put.customerId,
    });

    const callbackTokenHash = await this.registerCallbackIfConfigured(
      kycServer,
      jwt,
      put.customerId,
      customer.sellerId,
      existing?.callbackTokenHash,
    );

    const record: KycRecord = {
      sellerId: customer.sellerId,
      account: customer.account,
      customerId: put.customerId,
      status: after.status,
      requiredFields: after.requiredFields,
      providedFields: merged,
      callbackTokenHash,
      message: after.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }
}

/**
 * An anchor customer id belongs to the account it was created for. A record
 * with no account, or another one, dates from when every seller shared the
 * platform's account (or the seller changed wallet): its id points at somebody
 * else's customer, so look the seller up by their own account instead.
 */
function reusableCustomerId(existing: KycRecord | null, customer: AnchorCustomer): string | null {
  return existing?.account === customer.account ? existing.customerId : null;
}

/** `OFFRAMP=mock` has no real anchor and nothing to be compliant with — never
 *  gates the (simulated) cash-out path. */
export class NoKycRequired implements KycPort {
  async status(customer: AnchorCustomer): Promise<KycRecord> {
    return this.accepted(customer);
  }

  async submit(customer: AnchorCustomer): Promise<KycRecord> {
    return this.accepted(customer);
  }

  private accepted(customer: AnchorCustomer): KycRecord {
    return {
      sellerId: customer.sellerId,
      account: customer.account,
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
