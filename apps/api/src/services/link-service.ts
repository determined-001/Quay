import {
  canTransition,
  normalizeAmount,
  type CashOutBody,
  type CreateLinkBody,
  type LinkRepository,
  type MatchOutcome,
  type NormalizedPayment,
  type OffRampJob,
  type OffRampQuote,
  type OffRampPort,
  type PaymentLink,
  type PaymentRequest,
  type RailPort,
  type SellerRepository,
  type WebhookRepository,
} from "@checkout/core";
import { resolveAsset, type StellarConfig } from "@checkout/stellar";
import { newId, newReference } from "./ids";
import { WebhookSender } from "./webhook-sender";
import { metrics } from "../metrics";

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

export class LinkService {
  private readonly sender: WebhookSender;
  // Ephemeral: cash-out start time for the quote-to-settlement histogram. A
  // process restart mid-cash-out just loses that one latency sample — the
  // link's own status/offrampStatus fields remain the durable source of truth.
  private readonly cashOutStartedAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      links: LinkRepository;
      sellers: SellerRepository;
      webhooks: WebhookRepository;
      rail: RailPort;
      offramp: OffRampPort;
      stellar: StellarConfig;
    },
  ) {
    this.sender = new WebhookSender(deps.webhooks);
  }

  /** Webhook deliveries currently in flight (including in-process retries). */
  webhookQueueDepth(): number {
    return this.sender.inFlightCount;
  }

  private buildRequest(link: PaymentLink): PaymentRequest {
    return this.deps.rail.buildRequest({
      destination: link.destination,
      amount: link.amount,
      asset: link.asset,
      reference: link.reference,
      message: link.title,
    });
  }

  async createLink(body: CreateLinkBody): Promise<LinkWithRequest> {
    const seller = await this.deps.sellers.getDefault();
    const asset = resolveAsset(body.assetCode, this.deps.stellar);
    const expiresAt = body.expiresInMinutes
      ? Date.now() + body.expiresInMinutes * 60_000
      : null;

    const link = await this.deps.links.create({
      id: newId("lnk"),
      reference: newReference(),
      sellerId: seller.id,
      destination: seller.wallet,
      title: body.title,
      amount: normalizeAmount(body.amount),
      asset,
      expiresAt,
    });
    metrics.linkStatusTransitionsTotal.inc({ to: link.status });

    return { link, request: this.buildRequest(link) };
  }

  async listLinks(): Promise<PaymentLink[]> {
    const seller = await this.deps.sellers.getDefault();
    return this.deps.links.listBySeller(seller.id);
  }

  async getLink(id: string): Promise<LinkWithRequest | null> {
    const link = await this.deps.links.findById(id);
    if (!link) return null;
    return { link, request: this.buildRequest(link) };
  }

  /**
   * Apply a matched payment to its link. Returns whether the link advanced to
   * `paid` (so the worker can decide what to log). Idempotency of the *payment*
   * (processed-tx ledger) is the caller's responsibility; here we additionally
   * guard the domain transition so a duplicate can never double-apply.
   */
  async applyMatch(payment: NormalizedPayment, outcome: MatchOutcome): Promise<boolean> {
    if (outcome.kind === "paid") {
      const link = outcome.link;
      if (!canTransition(link.status, "paid")) return false; // already settled/terminal
      link.status = "paid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = normalizeAmount(payment.amount);
      await this.deps.links.save(link);
      metrics.linkStatusTransitionsTotal.inc({ to: "paid" });
      const paidAt = Date.parse(payment.createdAt);
      if (!Number.isNaN(paidAt)) metrics.paymentToPaidLatencySeconds.observe((Date.now() - paidAt) / 1000);
      await this.fireWebhook(link, "link.paid", { overpaid: outcome.overpaid });
      return true;
    }

    if (outcome.kind === "underpaid") {
      const link = outcome.link;
      if (!canTransition(link.status, "underpaid")) return false;
      link.status = "underpaid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = normalizeAmount(payment.amount);
      await this.deps.links.save(link);
      metrics.linkStatusTransitionsTotal.inc({ to: "underpaid" });
      await this.fireWebhook(link, "link.underpaid", {});
      return false;
    }

    return false; // no_memo / unknown_reference / asset_mismatch — nothing to apply
  }

  /** Seller-initiated cash-out: quote -> initiate -> move link to offramp_pending. */
  async triggerCashOut(linkId: string, body: CashOutBody): Promise<OffRampJob> {
    const link = await this.deps.links.findById(linkId);
    if (!link) throw new HttpError(404, "Link not found");
    if (link.status !== "paid") {
      throw new HttpError(409, `Link must be paid to cash out (is "${link.status}")`);
    }

    const sourceAmount = link.paidAmount ?? link.amount;
    let quote: OffRampQuote;
    let job: OffRampJob;
    try {
      quote = await this.deps.offramp.quote({
        sourceAsset: link.asset,
        sourceAmount,
        targetCurrency: body.targetCurrency,
      });
      job = await this.deps.offramp.initiate({
        linkId: link.id,
        quoteId: quote.quoteId,
        payout: { currency: body.targetCurrency, fields: body.payoutFields },
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Off-ramp error: ${message}`);
    }

    link.status = "offramp_pending";
    link.offrampJobId = job.jobId;
    link.offrampTargetCurrency = job.targetCurrency;
    link.offrampStatus = "pending";
    await this.deps.links.save(link);
    metrics.linkStatusTransitionsTotal.inc({ to: "offramp_pending" });
    this.cashOutStartedAt.set(link.id, Date.now());
    return job;
  }

  /** Advance any pending cash-outs by polling the off-ramp adapter. */
  async pollCashOuts(): Promise<void> {
    const pending = await this.deps.links.listByStatus("offramp_pending");
    for (const link of pending) {
      if (!link.offrampJobId) continue;
      let job: OffRampJob;
      try {
        job = await this.deps.offramp.status(link.offrampJobId);
      } catch {
        continue;
      }
      if (job.status === "settled") {
        link.status = "offramp_settled";
        link.offrampStatus = "settled";
        await this.deps.links.save(link);
        metrics.linkStatusTransitionsTotal.inc({ to: "offramp_settled" });
        this.observeSettlementDuration(link.id, "settled");
        await this.fireWebhook(link, "offramp.settled", {
          targetCurrency: job.targetCurrency,
          targetAmount: job.targetAmount,
        });
      } else if (job.status === "failed") {
        link.status = "offramp_failed";
        link.offrampStatus = "failed";
        await this.deps.links.save(link);
        metrics.linkStatusTransitionsTotal.inc({ to: "offramp_failed" });
        this.observeSettlementDuration(link.id, "failed");
        await this.fireWebhook(link, "offramp.failed", { reason: job.reason });
      }
    }
  }

  private observeSettlementDuration(linkId: string, outcome: "settled" | "failed"): void {
    const startedAt = this.cashOutStartedAt.get(linkId);
    if (startedAt === undefined) return; // process restarted mid-cash-out — no sample
    this.cashOutStartedAt.delete(linkId);
    metrics.quoteToSettlementDurationSeconds.observe({ outcome }, (Date.now() - startedAt) / 1000);
  }

  private async fireWebhook(
    link: PaymentLink,
    event: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const hooks = await this.deps.webhooks.listBySeller(link.sellerId);
    if (hooks.length === 0) return;
    await this.sender.dispatch(hooks, link.id, {
      event,
      data: {
        linkId: link.id,
        reference: link.reference,
        status: link.status,
        amount: link.amount,
        paidAmount: link.paidAmount,
        asset: link.asset,
        txHash: link.txHash,
        ...extra,
      },
    });
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
