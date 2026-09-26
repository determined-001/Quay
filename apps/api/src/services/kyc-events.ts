import type {
  AnchorCustomer,
  KycPort,
  KycRecord,
  KycRepository,
  WebhookRepository,
} from "@checkout/core";
import type { WebhookSender } from "./webhook-sender";

export interface KycEventsOptions {
  inner: KycPort;
  repo: KycRepository;
  webhooks: WebhookRepository;
  sender: WebhookSender;
  anchorDomain: string;
}

/**
 * Decorator around `KycPort` that emits webhooks on KYC status transitions.
 *
 * Webhooks emitted:
 *   - `kyc.accepted`   (when status transitions to ACCEPTED)
 *   - `kyc.rejected`   (when status transitions to REJECTED)
 *   - `kyc.needs_info` (when status transitions to NEEDS_INFO)
 *
 * Security:
 *   The payload never carries submitted PII (`providedFields`).
 *   `missingFields` contains only field names.
 *   `message` is included only for `REJECTED`, and is null for all other events.
 */
export class KycEvents implements KycPort {
  private readonly inner: KycPort;
  private readonly repo: KycRepository;
  private readonly webhooks: WebhookRepository;
  private readonly sender: WebhookSender;
  private readonly anchorDomain: string;

  constructor(opts: KycEventsOptions) {
    this.inner = opts.inner;
    this.repo = opts.repo;
    this.webhooks = opts.webhooks;
    this.sender = opts.sender;
    this.anchorDomain = opts.anchorDomain;
  }

  async status(customer: AnchorCustomer): Promise<KycRecord> {
    const previous = await this.repo.get(customer.sellerId);
    const result = await this.inner.status(customer);
    await this.emitIfTransitioned(customer.sellerId, previous, result);
    return result;
  }

  async submit(customer: AnchorCustomer, fields: Record<string, string>): Promise<KycRecord> {
    const previous = await this.repo.get(customer.sellerId);
    const result = await this.inner.submit(customer, fields);
    await this.emitIfTransitioned(customer.sellerId, previous, result);
    return result;
  }

  private async emitIfTransitioned(
    sellerId: string,
    previous: KycRecord | null,
    current: KycRecord,
  ): Promise<void> {
    const prevStatus = previous?.status ?? null;
    if (prevStatus === current.status) return;

    let eventType: "kyc.accepted" | "kyc.rejected" | "kyc.needs_info" | null = null;
    if (current.status === "ACCEPTED") eventType = "kyc.accepted";
    else if (current.status === "REJECTED") eventType = "kyc.rejected";
    else if (current.status === "NEEDS_INFO") eventType = "kyc.needs_info";

    if (!eventType) return;

    const missingFields = current.requiredFields
      ? current.requiredFields
          .filter((f) => !f.optional && !(current.providedFields[f.name] ?? "").trim())
          .map((f) => f.name)
      : [];

    const data = {
      anchorDomain: this.anchorDomain,
      status: current.status,
      previousStatus: prevStatus,
      missingFields,
      message: current.status === "REJECTED" ? current.message ?? null : null,
    };

    const hooks = await this.webhooks.listBySeller(sellerId);
    if (hooks.length > 0) {
      await this.sender.enqueueSellerEvent(hooks, sellerId, {
        event: eventType,
        data,
      });
    }
  }
}
