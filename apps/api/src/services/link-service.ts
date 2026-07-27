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
import type { DrizzleOfframpTelemetryRepository, TelemetryRow } from "../repos/index";

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

export class LinkService {
  private readonly sender: WebhookSender;

  constructor(
    private readonly deps: {
      links: LinkRepository;
      sellers: SellerRepository;
      webhooks: WebhookRepository;
      rail: RailPort;
      offramp: OffRampPort;
      stellar: StellarConfig;
      telemetry: DrizzleOfframpTelemetryRepository;
    },
  ) {
    this.sender = new WebhookSender(deps.webhooks);
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

      // Write "quoted" telemetry row immediately after getting the firm quote.
      const anchorDomain = anchorDomainFromOfframp(this.deps.offramp);
      const corridor = `${link.asset.code}/${body.targetCurrency}`;
      const telRow: TelemetryRow = {
        id: `tel_${quote.quoteId}`,
        anchorDomain,
        corridor,
        sellAsset: link.asset.issuer
          ? `stellar:${link.asset.code}:${link.asset.issuer}`
          : `stellar:native`,
        sellAmount: sourceAmount,
        indicativeRate: null,
        quotedRate: quote.rate,
        quotedAt: Date.now(),
        initiatedAt: null,
        settledAt: null,
        effectiveRate: null,
        feeAmount: null,
        status: "quoted",
        failureReason: null,
      };
      await this.deps.telemetry.upsert(telRow).catch(() => {/* telemetry must never block the cashout */});

      job = await this.deps.offramp.initiate({
        linkId: link.id,
        quoteId: quote.quoteId,
        payout: { currency: body.targetCurrency, fields: body.payoutFields },
      });

      // Update telemetry to "initiated" now that we have the jobId.
      await this.deps.telemetry.upsert({
        ...telRow,
        // remap id so subsequent status polls can look it up by jobId
        id: `tel_${job.jobId}`,
        initiatedAt: Date.now(),
        status: "initiated",
      }).catch(() => {});
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
        await this.fireWebhook(link, "offramp.settled", {
          targetCurrency: job.targetCurrency,
          targetAmount: job.targetAmount,
        });
        // Derive effective_rate from anchor-reported amount_out (not the quote).
        const sellAmount = link.paidAmount ?? link.amount;
        const effectiveRate =
          job.targetAmount && Number(sellAmount) > 0
            ? String(Number(job.targetAmount) / Number(sellAmount))
            : null;
        const feeAmount =
          effectiveRate && job.rate
            ? String(
                Math.max(
                  0,
                  Number(sellAmount) * Number(job.rate) - Number(job.targetAmount),
                ).toFixed(6),
              )
            : null;
        await this.deps.telemetry.upsert({
          id: `tel_${link.offrampJobId}`,
          anchorDomain: anchorDomainFromOfframp(this.deps.offramp),
          corridor: `${link.asset.code}/${link.offrampTargetCurrency ?? job.targetCurrency}`,
          sellAsset: link.asset.issuer
            ? `stellar:${link.asset.code}:${link.asset.issuer}`
            : `stellar:native`,
          sellAmount,
          indicativeRate: null,
          quotedRate: job.rate,
          quotedAt: 0, // already set on the row from initiate step; onConflict won't overwrite it
          initiatedAt: null,
          settledAt: Date.now(),
          effectiveRate,
          feeAmount,
          status: "settled",
          failureReason: null,
        }).catch(() => {});
      } else if (job.status === "failed") {
        link.status = "offramp_failed";
        link.offrampStatus = "failed";
        await this.deps.links.save(link);
        await this.fireWebhook(link, "offramp.failed", { reason: job.reason });
        await this.deps.telemetry.upsert({
          id: `tel_${link.offrampJobId}`,
          anchorDomain: anchorDomainFromOfframp(this.deps.offramp),
          corridor: `${link.asset.code}/${link.offrampTargetCurrency ?? job.targetCurrency}`,
          sellAsset: link.asset.issuer
            ? `stellar:${link.asset.code}:${link.asset.issuer}`
            : `stellar:native`,
          sellAmount: link.paidAmount ?? link.amount,
          indicativeRate: null,
          quotedRate: job.rate,
          quotedAt: 0,
          initiatedAt: null,
          settledAt: null,
          effectiveRate: null,
          feeAmount: null,
          status: "failed",
          failureReason: job.reason ?? "unknown",
        }).catch(() => {});
      }
    }
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

/**
 * Best-effort: extract a human-readable anchor domain from the offramp adapter.
 * Falls back to the constructor name so mock/test adapters still produce a label.
 */
function anchorDomainFromOfframp(offramp: { constructor: { name: string } } & Record<string, unknown>): string {
  if (typeof offramp["baseUrl"] === "string") {
    try {
      return new URL(offramp["baseUrl"] as string).hostname;
    } catch {
      // fall through
    }
  }
  return offramp.constructor.name; // "MockAnchorOffRamp" or "TestAnchorOffRamp"
}
