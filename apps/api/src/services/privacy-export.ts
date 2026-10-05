import type { Seller } from "@checkout/core";
import type { Container } from "./container";
import { DrizzleAnchorSessionRepository } from "../repos/index";

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
    customerId: string | null;
    status: string;
    message: string | null;
    providedFields: Record<string, string>;
    lastSyncedAt: string | null;
  }[];
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
  webhooks: { id: string; url: string; createdAt: string }[];
  apiKeys: { id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null }[];
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
    customerId: r.customerId,
    status: r.status,
    message: r.message,
    providedFields: r.providedFields,
    lastSyncedAt: isoOrNull(r.lastSyncedAt),
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
  const payments = await c.links.listPaymentsBySeller(sellerId);
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
  const [profile, kyc, consents, anchorConnections, links, payments, webhooks, apiKeys] = await Promise.all([
    profileSection(c, id),
    kycSection(c, id),
    consentsSection(c, id),
    anchorConnectionsSection(c, id),
    linksSection(c, id),
    paymentsSection(c, id),
    webhooksSection(c, id),
    apiKeysSection(c, id),
  ]);

  return {
    generatedAt: iso(now),
    seller: { id, name: seller.name, wallet: seller.wallet, createdAt: iso(seller.createdAt) },
    ...(profile ? { profile } : {}),
    ...(kyc ? { kyc } : {}),
    consents,
    anchorConnections,
    payoutFields: seller.payoutFields,
    links,
    payments,
    webhooks,
    apiKeys,
  };
}
