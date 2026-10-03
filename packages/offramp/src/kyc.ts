import {
  KycRequiredError,
  type AnchorCustomer,
  type KycFieldSpec,
  type KycPort,
  type KycRecord,
  type KycRepository,
  type ProvidedFieldStatus,
  type KycUploadFile,
} from "@checkout/core";
import type { AnchorDiscovery, SellerAnchorAuth } from "./anchor-session";
import { getSep12Customer, putSep12Customer, putSep12CustomerMultipart } from "./sep12";
import { selectFieldsForAnchor } from "@checkout/core";

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
  /** Profile repository for reusable SEP-9 fields. */
  profileRepo: { get(sellerId: string): Promise<{ fields: Record<string, string> } | null> };
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
  private readonly profileRepo: TestAnchorKycOptions["profileRepo"];

  constructor(opts: TestAnchorKycOptions) {
    this.discovery = opts.discovery;
    this.auth = opts.auth;
    this.repo = opts.repo;
    this.profileRepo = opts.profileRepo;
  }

  async status(customer: AnchorCustomer): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId, this.auth.anchorDomain);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const remote = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer, this.auth.anchorDomain),
    });

    const cleanProvided = stripBinaryFields(existing?.providedFields ?? {}, remote.requiredFields);
    const record: KycRecord = {
      sellerId: customer.sellerId,
      anchorDomain: this.auth.anchorDomain,
      account: customer.account,
      customerId: remote.customerId,
      status: remote.status,
      requiredFields: remote.requiredFields,
      providedFields: cleanProvided,
      providedFieldStatus: remote.providedFieldStatus,
      sentFields: existing?.sentFields ?? [],
      message: remote.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }

  async submit(customer: AnchorCustomer, fields: Record<string, string>): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId, this.auth.anchorDomain);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const discovery = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer, this.auth.anchorDomain),
    });

    // Get the reusable profile for this seller
    const profile = await this.profileRepo.get(customer.sellerId);

    // If the anchor has no customer record yet (discovery returns empty requiredFields),
    // send the fields directly to create the record, then re-read requirements.
    // This matches the old behavior where the first PUT reveals the real requirements.
    const isFirstSubmission = discovery.requiredFields.length === 0;

    let selection: { send: Record<string, string>; missing: string[]; unknown: string[] };
    if (isFirstSubmission) {
      // First submission: send all provided fields to let the anchor tell us what it needs
      selection = {
        send: fields,
        missing: [],
        unknown: [],
      };
    } else {
      // Get the reusable profile for this seller
      const profile = await this.profileRepo.get(customer.sellerId);

      // Use selectFieldsForAnchor to determine what to send
      selection = selectFieldsForAnchor({
        requested: discovery.requiredFields,
        profile: profile ? { fields: profile.fields } : { fields: {} },
        overrides: fields,
      });
    }

    // Fail fast if required fields are missing (only for non-first submissions)
    if (!isFirstSubmission && selection.missing.length > 0) throw new KycRequiredError(selection.missing);

    // Send only the selected fields
    const put = await putSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: discovery.customerId,
      fields: selection.send,
    });

    // The anchor may reveal more required fields only after seeing this
    // submission (SEP-12 is progressive) — re-sync rather than assume ACCEPTED.
    const after = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: put.customerId,
    });

    // Merge the new fields into the existing providedFields for future submissions
    // Values typed in this submission (overrides) are written back to the profile
    // for SEP-9 fields so they can be reused. Binary fields are never persisted.
    const mergedProvided = { ...existing?.providedFields, ...fields };
    const cleanProvided = stripBinaryFields(mergedProvided, [...discovery.requiredFields, ...after.requiredFields]);

    const record: KycRecord = {
      sellerId: customer.sellerId,
      anchorDomain: this.auth.anchorDomain,
      account: customer.account,
      customerId: put.customerId,
      status: after.status,
      requiredFields: after.requiredFields,
      providedFields: cleanProvided,
      providedFieldStatus: after.providedFieldStatus,
      sentFields: Object.keys(selection.send),
      message: after.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }

  /**
   * Upload binary SEP-12 fields (e.g. photo_id_front) as multipart. Only the
   * files are sent: text fields already on file are never re-sent from here,
   * so everything that reaches the anchor goes through the consent-checked
   * paths. Uploaded bytes are never stored; only the field names are recorded
   * in `sentFields`.
   */
  async submitFiles(customer: AnchorCustomer, files: KycUploadFile[]): Promise<KycRecord> {
    const existing = await this.repo.get(customer.sellerId, this.auth.anchorDomain);
    const jwt = await this.auth.token(customer);
    const { kycServer } = await this.discovery.get();
    const discovery = await getSep12Customer(kycServer, jwt, {
      account: customer.account,
      customerId: reusableCustomerId(existing, customer, this.auth.anchorDomain),
    });

    const put = await putSep12CustomerMultipart(kycServer, jwt, {
      account: customer.account,
      customerId: discovery.customerId,
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
      anchorDomain: this.auth.anchorDomain,
      account: customer.account,
      customerId: put.customerId,
      status: after.status,
      requiredFields: after.requiredFields,
      providedFields: cleanProvided,
      providedFieldStatus: after.providedFieldStatus,
      sentFields: [...new Set([...(existing?.sentFields ?? []), ...files.map((x) => x.name)])],
      message: after.message,
      lastSyncedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.repo.save(record);
    return record;
  }
}

/**
 * An anchor customer id belongs to the anchor that assigned it and to the
 * account it was created for. A record
 * with no account, or another one, dates from when every seller shared the
 * platform's account (or the seller changed wallet): its id points at somebody
 * else's customer, so look the seller up by their own account instead.
 */
function reusableCustomerId(
  existing: KycRecord | null,
  customer: AnchorCustomer,
  anchorDomain: string,
): string | null {
  if (!existing) return null;
  // The id is assigned by one anchor: never send it to another (issue 4.24).
  // A "legacy" row has no attributable anchor, so it never matches.
  if (existing.anchorDomain !== anchorDomain) return null;
  return existing.account === customer.account ? existing.customerId : null;
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
      anchorDomain: "mock",
      account: customer.account,
      customerId: null,
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      providedFieldStatus: [],
      sentFields: [],
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    };
  }
}

