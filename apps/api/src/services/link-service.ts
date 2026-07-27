import {
  canTransition,
  normalizeAmount,
  type CashOutBody,
  type CreateLinkBody,
  type LinkRepository,
  type Logger,
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

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

export interface ServiceCallOptions {
  /** Optional ambient logger. If absent, falls back to `deps.logger` (the root). */
  logger?: Logger;
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
      logger: Logger;
    },
  ) {
    this.sender = new WebhookSender(deps.webhooks, { logger: deps.logger });
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

  async createLink(body: CreateLinkBody, opts: ServiceCallOptions = {}): Promise<LinkWithRequest> {
    const log = (opts.logger ?? this.deps.logger);
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

    log.info(
      {
        event: "link.created",
        linkId: link.id,
        reference: link.reference,
        sellerId: link.sellerId,
        destination: link.destination,
        amount: link.amount,
        assetCode: link.asset.code,
        assetIssuer: link.asset.issuer,
        expiresAt: link.expiresAt,
      },
      "link created",
    );

    return { link, request: this.buildRequest(link) };
  }

  async listLinks(_opts: ServiceCallOptions = {}): Promise<PaymentLink[]> {
    return this.deps.sellers.getDefault().then((s) => this.deps.links.listBySeller(s.id));
  }

  async getLink(id: string, _opts: ServiceCallOptions = {}): Promise<LinkWithRequest | null> {
    const link = await this.deps.links.findById(id);
    if (!link) return null;
    return { link, request: this.buildRequest(link) };
  }

  /**
   * Apply a matched payment to its link. Returns whether the link advanced to
   * `paid` (so the watcher can decide what to log). Idempotency of the *payment*
   * (processed-tx ledger) is the caller's responsibility; here we additionally
   * guard the domain transition so a duplicate can never double-apply.
   *
   * The watcher emits one `payment.matched` line for every payment it inspects
   * (paid/underpaid/no_memo/unknown_reference/asset_mismatch). Here we ONLY
   * emit `link.transition` when an actual state change is committed, so we
   * do not duplicate the per-payment line. Illegal-transition re-applies
   * emit a single `link.transition.illegal` warning for grep.
   */
  async applyMatch(payment: NormalizedPayment, outcome: MatchOutcome, opts: ServiceCallOptions = {}): Promise<boolean> {
    // Use the ambient logger directly. Watcher passes a per-payment child
    // (`txHash + pagingToken` already bound); elsewhere txHash appears in the
    // per-event payload. Either way pino's parent chain + payload merge gives
    // us the correlations we need without re-binding the same key.
    const log = (opts.logger ?? this.deps.logger);

    if (outcome.kind === "paid") {
      const link = outcome.link;
      if (!canTransition(link.status, "paid")) {
        log.warn(
          { event: "link.transition.illegal", linkId: link.id, txHash: payment.txHash, from: link.status, to: "paid" },
          "ignored payment (already settled)",
        );
        return false; // already settled/terminal
      }
      const from = link.status;
      link.status = "paid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = normalizeAmount(payment.amount);
      await this.deps.links.save(link);
      log.info(
        { event: "link.transition", linkId: link.id, reference: link.reference, txHash: payment.txHash, from, to: link.status, overpaid: outcome.overpaid, paidAmount: link.paidAmount, payer: link.payer },
        "link paid",
      );
      await this.fireWebhook(link, "link.paid", { overpaid: outcome.overpaid }, opts);
      return true;
    }

    if (outcome.kind === "underpaid") {
      const link = outcome.link;
      if (!canTransition(link.status, "underpaid")) {
        log.warn(
          { event: "link.transition.illegal", linkId: link.id, txHash: payment.txHash, from: link.status, to: "underpaid" },
          "ignored payment (already settled)",
        );
        return false;
      }
      const from = link.status;
      link.status = "underpaid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = normalizeAmount(payment.amount);
      await this.deps.links.save(link);
      log.info(
        { event: "link.transition", linkId: link.id, reference: link.reference, txHash: payment.txHash, from, to: link.status, paidAmount: link.paidAmount, payer: link.payer },
        "link underpaid",
      );
      await this.fireWebhook(link, "link.underpaid", {}, opts);
      return false;
    }

    // Other outcomes (no_memo / unknown_reference / asset_mismatch) — these
    // are recorded by the watcher's `payment.matched` line just before the
    // service call. Nothing to log here.
    return false;
  }

  /** Seller-initiated cash-out: quote -> initiate -> move link to offramp_pending. */
  async triggerCashOut(linkId: string, body: CashOutBody, opts: ServiceCallOptions = {}): Promise<OffRampJob> {
    const baseLog = (opts.logger ?? this.deps.logger);
    const link = await this.deps.links.findById(linkId);
    if (!link) throw new HttpError(404, "Link not found");
    if (link.status !== "paid") {
      throw new HttpError(409, `Link must be paid to cash out (is "${link.status}")`);
    }

    const child = baseLog.child({ linkId: link.id, reference: link.reference });
    // `child` carries requestId (when called from a route) AND linkId+reference.
    // Threading it into the offramp makes the SEP-* anchor.* events inherit
    // the same correlation IDs (the brief's "end to end" requirement).
    const sourceAmount = link.paidAmount ?? link.amount;
    let quote: OffRampQuote;
    let job: OffRampJob;
    const t0 = Date.now();
    try {
      quote = await this.deps.offramp.quote({
        sourceAsset: link.asset,
        sourceAmount,
        targetCurrency: body.targetCurrency,
      }, { logger: child });
      child.info(
        {
          event: "cashout.quote",
          anchor: this.deps.offramp.mode,
          quoteId: quote.quoteId,
          targetCurrency: quote.targetCurrency,
          targetAmount: quote.targetAmount,
          rate: quote.rate,
          durationMs: Date.now() - t0,
        },
        "cash-out quoted",
      );

      const t1 = Date.now();
      job = await this.deps.offramp.initiate({
        linkId: link.id,
        quoteId: quote.quoteId,
        payout: { currency: body.targetCurrency, fields: body.payoutFields },
      }, { logger: child });
      child.info(
        {
          event: "cashout.initiate",
          anchor: this.deps.offramp.mode,
          jobId: job.jobId,
          targetCurrency: job.targetCurrency,
          durationMs: Date.now() - t1,
        },
        "cash-out initiated",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      child.error(
        { event: "cashout.error", anchor: this.deps.offramp.mode, error: message },
        "cash-out failed",
      );
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Off-ramp error: ${message}`);
    }

    const from = link.status;
    link.status = "offramp_pending";
    link.offrampJobId = job.jobId;
    link.offrampTargetCurrency = job.targetCurrency;
    link.offrampStatus = "pending";
    await this.deps.links.save(link);
    child.info(
      { event: "link.transition", from, to: link.status, jobId: job.jobId, targetCurrency: job.targetCurrency },
      "link offramp pending",
    );
    return job;
  }

  /** Advance any pending cash-outs by polling the off-ramp adapter. */
  async pollCashOuts(opts: ServiceCallOptions = {}): Promise<void> {
    const log = (opts.logger ?? this.deps.logger);
    const pending = await this.deps.links.listByStatus("offramp_pending");
    for (const link of pending) {
      if (!link.offrampJobId) continue;
      const child = log.child({
        linkId: link.id,
        reference: link.reference,
        jobId: link.offrampJobId,
      });
      let job: OffRampJob;
      try {
        job = await this.deps.offramp.status(link.offrampJobId, { logger: child });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        child.error({ event: "cashout.poll.error", error: message }, "cash-out poll failed");
        continue;
      }
      if (job.status === "settled") {
        const from = link.status;
        link.status = "offramp_settled";
        link.offrampStatus = "settled";
        await this.deps.links.save(link);
        child.info(
          { event: "link.transition", from, to: link.status, targetAmount: job.targetAmount, targetCurrency: job.targetCurrency },
          "off-ramp settled",
        );
        await this.fireWebhook(link, "offramp.settled", {
          targetCurrency: job.targetCurrency,
          targetAmount: job.targetAmount,
        }, opts);
      } else if (job.status === "failed") {
        const from = link.status;
        link.status = "offramp_failed";
        link.offrampStatus = "failed";
        await this.deps.links.save(link);
        child.info(
          { event: "link.transition", from, to: link.status, reason: job.reason },
          "off-ramp failed",
        );
        await this.fireWebhook(link, "offramp.failed", { reason: job.reason }, opts);
      }
    }
  }

  private async fireWebhook(
    link: PaymentLink,
    event: string,
    extra: Record<string, unknown>,
    opts: ServiceCallOptions,
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
    }, opts);
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
