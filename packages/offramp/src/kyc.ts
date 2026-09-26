import {
  KycRequiredError,
  type AnchorCustomer,
  type KycFieldSpec,
  type KycPort,
  type KycRecord,
  type KycRepository,
  type KycUploadFile,
} from "@checkout/core";
import type { AnchorDiscovery, SellerAnchorAuth } from "./anchor-session";
import { getSep12Customer, putSep12Customer, putSep12CustomerMultipart } from "./sep12";

/** Non-optional fields in `required` that `values` doesn't have a non-blank
 *  entry for. Binary fields are handled via file uploads, so they are excluded
 *  from text-field completeness checks. */
export function missingRequiredFields(required: KycFieldSpec[], values: Record<string, string>): string[] {
  return required
    .filter((f) => !f.optional && f.type !== "binary" && !(values[f.name] ?? "").trim())
    .map((f) => f.name);
}

function stripBinaryFields(provided: Record<string, string>, required: KycFieldSpec[]): Record<string, string> {
  const binaryNames = new Set(required.filter((f) => f.type === "binary").map((f) => f.name));
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(provided)) {
    if (!binaryNames.has(k)) {
      result[k] = v;
    }
  }
  return result;
}

export interface TestAnchorKycOptions {
  discovery: AnchorDiscovery;
  /** The seller's own SEP-10 session with the anchor — never a platform key. */
  auth: SellerAnchorAuth;
  repo: KycRepository;
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

  constructor(opts: TestAnchorKycOptions) {
    this.discovery = opts.discovery;
    this.auth = opts.auth;
    this.repo = opts.repo;
  }

  async status(customer: AnchorCustomer): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const remote = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer),
    });

    const cleanProvided = stripBinaryFields(existing?.providedFields ?? {}, remote.requiredFields);
    const record: KycRecord = {
      sellerId: customer.sellerId,
      account: customer.account,
      customerId: remote.customerId,
      status: remote.status,
      requiredFields: remote.requiredFields,
      providedFields: cleanProvided,
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

    const cleanProvided = stripBinaryFields(merged, [...discovery.requiredFields, ...after.requiredFields]);
    const record: KycRecord = {
      sellerId: customer.sellerId,
      account: customer.account,
      customerId: put.customerId,
      status: after.status,
      requiredFields: after.requiredFields,
      providedFields: cleanProvided,
      message: after.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }

  async submitFiles(customer: AnchorCustomer, files: KycUploadFile[]): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const discovery = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer),
    });

    const put = await putSep12CustomerMultipart(kycServer, jwt, {
      account: customer.account,
      customerId: discovery.customerId,
      fields: existing?.providedFields,
      files,
    });

    const after = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: put.customerId,
    });

    const cleanProvided = stripBinaryFields(existing?.providedFields ?? {}, [
      ...discovery.requiredFields,
      ...after.requiredFields,
    ]);

    const record: KycRecord = {
      sellerId: customer.sellerId,
      account: customer.account,
      customerId: put.customerId,
      status: after.status,
      requiredFields: after.requiredFields,
      providedFields: cleanProvided,
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

  async submitFiles(customer: AnchorCustomer): Promise<KycRecord> {
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

