import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Seller } from "@checkout/core";
import type { Container } from "./container";
import { DrizzleAnchorSessionRepository } from "../repos/index";
import { kycDisclosureFields, links as linksTable, offrampJobs } from "../db/schema";

/**
 * Hard ceiling per list section, so one request cannot read an unbounded table
 * into memory. A section cut at the ceiling is named in `truncated`; the seller
 * can ask the operator for the remainder.
 */
export const EXPORT_SECTION_LIMIT = 10_000;

/**
 * The seller's data-subject export (NDPA 2023 right of access, issue 4.27).
 *
 * One small function per section, each reading through an existing repository
 * and mapping to an explicit list of fields. Nothing is spread from a row:
 * a column added to a table tomorrow is NOT exported until it is added here on
 * purpose, which is the safe direction for a document whose whole contract is
 * "personal data in, credentials never".
 *
 * Never exported, by construction: the anchor SEP-10 token (the anchor-session
 * read selects no token column), webhook secrets, API key hashes and prefixes,
 * the KYC callback token hash.
 *
 * Deliberately not exported (not personal data about the seller, or derived from
 * what is exported): off-ramp quotes, the anchor's deposit instructions and raw
 * error text on off-ramp jobs, webhook delivery logs and queue, idempotency keys,
 * revoked session ids, watcher cursors and telemetry.
 *
 * A section whose store is not configured on this deployment (the encrypted
 * profile and KYC stores need a real anchor and KYC_ENCRYPTION_KEY) is omitted
 * rather than reported empty, so an empty array always means "nothing held".
 */
export interface SellerExport {
  generatedAt: string;
  seller: { id: string; name: string; wallet: string; createdAt: string };
  profile?: { field: string; value: string; source: string; updatedAt: string }[];
  kyc?: {
    anchorDomain: string;
    account: string | null;
    customerId: string | null;
    status: string;
    message: string | null;
    providedFields: Record<string, string>;
    providedFieldStatus: { name: string; status: string | null; error: string | null }[];
    sentFields: string[];
    lastSyncedAt: string | null;
  }[];
  /** When each field's value was last sent to each anchor (names and times, never values). */
  disclosures: { anchorDomain: string; fieldName: string; sentAt: string }[];
  consents: {
    anchorDomain: string;
    fields: string[];
    grantedAt: string;
    revokedAt: string | null;
    noticeVersion: string;
  }[];
  anchorConnections: { anchorDomain: string; account: string; expiresAt: string }[];
  payoutFields: Record<string, string> | null;
  links: {
    id: string;
    reference: string;
    title: string;
    amount: string;
    asset: string;
    assetIssuer: string | null;
    status: string;
    createdAt: string;
  }[];
  payments: {
    linkId: string;
    txHash: string;
    payer: string;
    amount: string;
    asset: string;
    ledger: number | null;
    createdAt: string;
  }[];
  offrampJobs: {
    jobId: string;
    linkId: string;
    anchor: string;
    account: string | null;
    targetCurrency: string;
    targetAmount: string;
    rate: string;
    status: string;
    sellAsset: string | null;
    sellAmount: string | null;
    sellerTxHash: string | null;
    amountIn: string | null;
    amountFee: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  webhooks: { id: string; url: string; createdAt: string }[];
  apiKeys: { id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null }[];
  /** Names of list sections cut at {@link EXPORT_SECTION_LIMIT}; omitted when nothing was cut. */
  truncated?: string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null | undefined): string | null => (ms == null ? null : iso(ms));

type ExportDeps = Pick<
  Container,
  "db" | "links" | "webhooks" | "apiKeys" | "kycConsents" | "sellerProfile" | "kycRepo"
>;

async function profileSection(c: ExportDeps, sellerId: string): Promise<SellerExport["profile"]> {
  if (!c.sellerProfile) return undefined;
  const fields = await c.sellerProfile.list(sellerId);
  return fields.map((f) => ({
    field: f.field,
    value: f.value,
    source: f.source,
    updatedAt: iso(f.updatedAt),
  }));
}

async function kycSection(c: ExportDeps, sellerId: string): Promise<SellerExport["kyc"]> {
  if (!c.kycRepo) return undefined;
  const records = await c.kycRepo.list(sellerId);
  return records.map((r) => ({
    anchorDomain: r.anchorDomain,
    account: r.account,
    customerId: r.customerId,
    status: r.status,
    message: r.message,
    providedFields: r.providedFields,
    providedFieldStatus: r.providedFieldStatus.map((p) => ({ name: p.name, status: p.status, error: p.error })),
    sentFields: [...r.sentFields],
    lastSyncedAt: isoOrNull(r.lastSyncedAt),
  }));
}

async function disclosuresSection(c: ExportDeps, sellerId: string): Promise<SellerExport["disclosures"]> {
  const rows = await c.db
    .select({
      anchorDomain: kycDisclosureFields.anchorDomain,
      fieldName: kycDisclosureFields.fieldName,
      sentAt: kycDisclosureFields.sentAt,
    })
    .from(kycDisclosureFields)
    .where(eq(kycDisclosureFields.sellerId, sellerId))
    .orderBy(asc(kycDisclosureFields.anchorDomain), asc(kycDisclosureFields.fieldName))
    .limit(EXPORT_SECTION_LIMIT + 1);
  return rows.map((r) => ({ anchorDomain: r.anchorDomain, fieldName: r.fieldName, sentAt: iso(r.sentAt) }));
}

/**
 * Off-ramp jobs the seller ran: by the job's own seller id, or (older rows with
 * no seller id) through a link the seller owns. Explicit column list: the anchor's
 * transfer instructions (memo) and raw error text are not selected.
 */
async function offrampJobsSection(c: ExportDeps, sellerId: string): Promise<SellerExport["offrampJobs"]> {
  const rows = await c.db
    .select({
      jobId: offrampJobs.jobId,
      linkId: offrampJobs.linkId,
      anchor: offrampJobs.anchor,
      account: offrampJobs.account,
      targetCurrency: offrampJobs.targetCurrency,
      targetAmount: offrampJobs.targetAmount,
      rate: offrampJobs.rate,
      status: offrampJobs.status,
      sellAssetCode: offrampJobs.sellAssetCode,
      sellAssetIssuer: offrampJobs.sellAssetIssuer,
      sellAmount: offrampJobs.sellAmount,
      sellerTxHash: offrampJobs.sellerTxHash,
      amountIn: offrampJobs.amountIn,
      amountFee: offrampJobs.amountFee,
      createdAt: offrampJobs.createdAt,
      updatedAt: offrampJobs.updatedAt,
    })
    .from(offrampJobs)
    .where(
      or(
        eq(offrampJobs.sellerId, sellerId),
        and(
          isNull(offrampJobs.sellerId),
          inArray(offrampJobs.linkId, c.db.select({ id: linksTable.id }).from(linksTable).where(eq(linksTable.sellerId, sellerId))),
        ),
      ),
    )
    .orderBy(desc(offrampJobs.createdAt))
    .limit(EXPORT_SECTION_LIMIT + 1);
  return rows.map((r) => ({
    jobId: r.jobId,
    linkId: r.linkId,
    anchor: r.anchor,
    account: r.account,
    targetCurrency: r.targetCurrency,
    targetAmount: r.targetAmount,
    rate: r.rate,
    status: r.status,
    sellAsset: r.sellAssetCode ? (r.sellAssetIssuer ? `${r.sellAssetCode}:${r.sellAssetIssuer}` : r.sellAssetCode) : null,
    sellAmount: r.sellAmount,
    sellerTxHash: r.sellerTxHash,
    amountIn: r.amountIn,
    amountFee: r.amountFee,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  }));
}

async function consentsSection(c: ExportDeps, sellerId: string): Promise<SellerExport["consents"]> {
  const consents = await c.kycConsents.list(sellerId);
  return consents.map((k) => ({
    anchorDomain: k.anchorDomain,
    fields: k.fields,
    grantedAt: iso(k.grantedAt),
    revokedAt: isoOrNull(k.revokedAt),
    noticeVersion: k.noticeVersion,
  }));
}

async function anchorConnectionsSection(
  c: ExportDeps,
  sellerId: string,
): Promise<SellerExport["anchorConnections"]> {
  const sessions = await new DrizzleAnchorSessionRepository(c.db).listBySeller(sellerId);
  return sessions.map((s) => ({
    anchorDomain: s.anchorDomain,
    account: s.account,
    expiresAt: iso(s.expiresAt),
  }));
}

async function linksSection(c: ExportDeps, sellerId: string): Promise<SellerExport["links"]> {
  const links = await c.links.listBySeller(sellerId);
  return links.map((l) => ({
    id: l.id,
    reference: l.reference,
    title: l.title,
    amount: l.amount,
    asset: l.asset.code,
    assetIssuer: l.asset.issuer ?? null,
    status: l.status,
    createdAt: iso(l.createdAt),
  }));
}

async function paymentsSection(c: ExportDeps, sellerId: string): Promise<SellerExport["payments"]> {
  const payments = await c.links.listPaymentsBySeller(sellerId, EXPORT_SECTION_LIMIT + 1);
  return payments.map((p) => ({
    linkId: p.linkId,
    txHash: p.txHash,
    payer: p.payer,
    amount: p.amount,
    asset: p.assetCode,
    ledger: p.ledger,
    createdAt: iso(p.createdAt),
  }));
}

async function webhooksSection(c: ExportDeps, sellerId: string): Promise<SellerExport["webhooks"]> {
  const hooks = await c.webhooks.listBySeller(sellerId);
  return hooks.map((w) => ({ id: w.id, url: w.url, createdAt: iso(w.createdAt) }));
}

async function apiKeysSection(c: ExportDeps, sellerId: string): Promise<SellerExport["apiKeys"]> {
  const keys = await c.apiKeys.listBySeller(sellerId);
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    scopes: [...k.scopes],
    createdAt: iso(k.createdAt),
    lastUsedAt: isoOrNull(k.lastUsedAt),
  }));
}

/** Builds the export for exactly one seller. Every read below is keyed on `seller.id`. */
export async function buildSellerExport(
  c: ExportDeps,
  seller: Seller,
  now: number = Date.now(),
): Promise<SellerExport> {
  const id = seller.id;
  const [profile, kyc, disclosures, consents, anchorConnections, links, payments, jobs, webhooks, apiKeys] =
    await Promise.all([
      profileSection(c, id),
      kycSection(c, id),
      disclosuresSection(c, id),
      consentsSection(c, id),
      anchorConnectionsSection(c, id),
      linksSection(c, id),
      paymentsSection(c, id),
      offrampJobsSection(c, id),
      webhooksSection(c, id),
      apiKeysSection(c, id),
    ]);

  const truncated: string[] = [];
  const cap = <T>(name: string, rows: T[]): T[] => {
    if (rows.length <= EXPORT_SECTION_LIMIT) return rows;
    truncated.push(name);
    return rows.slice(0, EXPORT_SECTION_LIMIT);
  };

  return {
    generatedAt: iso(now),
    seller: { id, name: seller.name, wallet: seller.wallet, createdAt: iso(seller.createdAt) },
    ...(profile ? { profile } : {}),
    ...(kyc ? { kyc } : {}),
    disclosures: cap("disclosures", disclosures),
    consents,
    anchorConnections,
    payoutFields: seller.payoutFields,
    links: cap("links", links),
    payments: cap("payments", payments),
    offrampJobs: cap("offrampJobs", jobs),
    webhooks,
    apiKeys,
    ...(truncated.length > 0 ? { truncated } : {}),
  };
}
