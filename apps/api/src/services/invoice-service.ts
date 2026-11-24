import type { Logger, LinkRepository, WebhookRepository, PaymentLink } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";
import type { WebhookSender } from "./webhook-sender";
import { env } from "../env";

export type StoredInvoiceStatus = "draft" | "open" | "paid" | "void";
export type DerivedInvoiceStatus = "draft" | "open" | "paid" | "overdue" | "void";

export interface Invoice {
  id: string;
  sellerId: string;
  linkId: string;
  number: string;
  clientName?: string | null;
  clientEmail?: string | null;
  total: string;
  assetCode: string;
  assetIssuer: string | null;
  status: StoredInvoiceStatus;
  dueAt: number;
  overdueNotifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InvoiceRepository {
  create(input: {
    id: string;
    sellerId: string;
    linkId: string;
    number: string;
    clientName?: string | null;
    clientEmail?: string | null;
    total: string;
    assetCode: string;
    assetIssuer?: string | null;
    status?: StoredInvoiceStatus;
    dueAt: number;
    overdueNotifiedAt?: number | null;
  }): Promise<Invoice>;
  findById(id: string): Promise<Invoice | null>;
  listCandidatesForOverdue(now: number): Promise<Invoice[]>;
  claimForOverdue(id: string, now: number): Promise<boolean>;
  releaseOverdueClaim?(id: string): Promise<void>;
}

export interface InvoiceServiceDeps {
  invoices: InvoiceRepository;
  links: LinkRepository;
  webhooks: WebhookRepository;
  webhookSender: WebhookSender;
  invoicesEnabled?: boolean;
  logger?: Logger;
}

/**
 * Derives current invoice status per issue 1.14:
 * "overdue" is DERIVED (open, unpaid, now > dueAt) and never stored.
 */
export function getDerivedInvoiceStatus(
  invoice: { status: StoredInvoiceStatus; dueAt: number },
  now: number,
  link?: PaymentLink | null,
): DerivedInvoiceStatus {
  if (invoice.status === "draft") return "draft";
  if (invoice.status === "void") return "void";
  if (invoice.status === "paid") return "paid";

  if (link && (link.status === "paid" || link.status === "offramp_pending" || link.status === "offramp_settled")) {
    return "paid";
  }

  // Not yet due: dueAt >= now (strict inequality for overdue: now > dueAt)
  if (now > invoice.dueAt) {
    return "overdue";
  }

  return "open";
}

export class InvoiceService {
  private readonly logger: Logger;

  constructor(private readonly deps: InvoiceServiceDeps) {
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * Walks open overdue invoices and fires `invoice.overdue` webhook once per invoice.
   *
   * Gated by INVOICES_ENABLED: when false, does nothing (no DB reads, no queue writes).
   * Atomically claims each candidate row before enqueueing so concurrent sweeps fire at most once.
   */
  async sweepOverdue(now: number): Promise<number> {
    const enabled = this.deps.invoicesEnabled ?? env.invoicesEnabled;
    if (!enabled) return 0;

    const candidates = await this.deps.invoices.listCandidatesForOverdue(now);
    let notifiedCount = 0;

    for (const invoice of candidates) {
      try {
        const link = await this.deps.links.findById(invoice.linkId);
        const derived = getDerivedInvoiceStatus(invoice, now, link);
        if (derived !== "overdue") {
          continue;
        }

        // Single conditional claim before enqueueing
        const claimed = await this.deps.invoices.claimForOverdue(invoice.id, now);
        if (!claimed) {
          continue;
        }

        const hooks = await this.deps.webhooks.listBySeller(invoice.sellerId);
        if (hooks.length > 0) {
          const payloadData = {
            invoiceId: invoice.id,
            number: invoice.number,
            linkId: invoice.linkId,
            total: invoice.total,
            paidAmount: link?.paidAmount ?? null,
            asset: {
              code: invoice.assetCode,
              issuer: invoice.assetIssuer ?? null,
            },
            dueAt: invoice.dueAt,
          };

          try {
            await this.deps.webhookSender.enqueue(hooks, invoice.linkId, {
              event: "invoice.overdue",
              data: payloadData,
            });
          } catch (enqueueErr) {
            this.logger.error(`failed to enqueue invoice.overdue for invoice ${invoice.id}: ${String(enqueueErr)}`);
            if (this.deps.invoices.releaseOverdueClaim) {
              try {
                await this.deps.invoices.releaseOverdueClaim(invoice.id);
              } catch (unclaimErr) {
                this.logger.error(`failed to release overdue claim for invoice ${invoice.id}: ${String(unclaimErr)}`);
              }
            }
            continue;
          }
        }

        notifiedCount++;
      } catch (err) {
        this.logger.error(`error in sweepOverdue for invoice ${invoice.id}: ${String(err)}`);
      }
    }

    return notifiedCount;
  }
}
