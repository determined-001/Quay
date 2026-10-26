import {
  NOOP_LOGGER,
  OffRampJobNotFoundError,
  type AnchorCustomer,
  type IndicativePrice,
  type Logger,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type OffRampStateRepository,
  type OfframpRequirementTypes,
  type SellerPayoutRef,
  type AssetRef,
} from "@checkout/core";
import { AnchorCapabilityError, capabilities, type Sep1DiscoveryInfo } from "./sep1";

/**
 * Which anchor protocol carries a withdrawal (issue 3.19).
 *
 * `auto` reads the anchor's SEP-1 declaration: SEP-6 when it publishes
 * `TRANSFER_SERVER` (no popup, the seller never leaves the dashboard), else
 * SEP-24 when it publishes `TRANSFER_SERVER_SEP0024`. `sep6` / `sep24` force one
 * and refuse to start a withdrawal when the anchor does not declare it.
 */
export type OffRampProtocol = "auto" | "sep6" | "sep24";
export type ResolvedOffRampProtocol = "sep6" | "sep24";

export const OFFRAMP_PROTOCOLS: readonly OffRampProtocol[] = ["auto", "sep6", "sep24"];

/**
 * Suffix the SEP-24 adapter puts on `StoredOffRampJob.anchor` (`<domain>#sep24`).
 * SEP-6 jobs carry the bare home domain. This is the only thing that says which
 * protocol a job belongs to, so it is what `status()` routes on.
 */
export const SEP24_JOB_MARKER = "#sep24";

/** The protocol that created a job, from its stored `anchor` label. */
export function protocolOfJob(anchor: string): ResolvedOffRampProtocol {
  return anchor.endsWith(SEP24_JOB_MARKER) ? "sep24" : "sep6";
}

/**
 * Picks the protocol for an anchor's declared capabilities. Throws an
 * {@link AnchorCapabilityError} naming what the anchor does declare when the
 * wish cannot be met.
 */
export function chooseProtocol(preference: OffRampProtocol, info: Sep1DiscoveryInfo): ResolvedOffRampProtocol {
  const caps = capabilities(info);
  const declared = (["sep6", "sep24", "sep38", "sep12"] as const).filter((k) => caps[k]);
  if (preference === "sep6") {
    if (!caps.sep6) throw new AnchorCapabilityError(info.homeDomain, "SEP-6 (TRANSFER_SERVER)", declared);
    return "sep6";
  }
  if (preference === "sep24") {
    if (!caps.sep24) throw new AnchorCapabilityError(info.homeDomain, "SEP-24 (TRANSFER_SERVER_SEP0024)", declared);
    return "sep24";
  }
  if (caps.sep6) return "sep6";
  if (caps.sep24) return "sep24";
  throw new AnchorCapabilityError(
    info.homeDomain,
    "a transfer server (TRANSFER_SERVER for SEP-6 or TRANSFER_SERVER_SEP0024 for SEP-24)",
    declared,
  );
}

export interface SelectingOffRampOptions {
  discovery: { readonly homeDomain: string; get(): Promise<Sep1DiscoveryInfo> };
  /** `OFFRAMP_PROTOCOL`. */
  protocol: OffRampProtocol;
  /** The SEP-6 adapter (`TestAnchorOffRamp`). */
  sep6: OffRampPort;
  /** The SEP-24 adapter (`AnchorOffRamp`). */
  sep24: OffRampPort;
  /** Read only to learn which protocol a job was started under. */
  state: OffRampStateRepository;
  logger?: Logger;
}

/**
 * Routes each call to the SEP-6 or SEP-24 adapter.
 *
 * New work (`quote`, `initiate`, `offrampRequirements`) follows the configured
 * preference against what the anchor declares. `status()` does not: it follows
 * the job. A withdrawal started over SEP-24 keeps polling over SEP-24 after the
 * operator flips the preference to `sep6`, because only that protocol knows the
 * job id.
 *
 * The anchor is read once. A result from a failed stellar.toml fetch (guessed
 * paths) is used for the call at hand but never remembered, so a transient
 * outage cannot pin the choice.
 */
export class SelectingOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly discovery: SelectingOffRampOptions["discovery"];
  private readonly preference: OffRampProtocol;
  private readonly sep6: OffRampPort;
  private readonly sep24: OffRampPort;
  private readonly state: OffRampStateRepository;
  private readonly logger: Logger;
  private resolved: ResolvedOffRampProtocol | null = null;

  constructor(opts: SelectingOffRampOptions) {
    this.discovery = opts.discovery;
    this.preference = opts.protocol;
    this.sep6 = opts.sep6;
    this.sep24 = opts.sep24;
    this.state = opts.state;
    this.logger = (opts.logger ?? NOOP_LOGGER).child({ component: "offramp.select", anchor: opts.discovery.homeDomain });
  }

  /**
   * The protocol new withdrawals use. Logs `offramp.protocol` the first time it
   * is settled. Throws {@link AnchorCapabilityError} when the anchor declares
   * nothing usable (or not what a forced preference asks for).
   */
  async protocol(): Promise<ResolvedOffRampProtocol> {
    if (this.resolved) return this.resolved;
    const info = await this.discovery.get();
    const protocol = chooseProtocol(this.preference, info);
    if (!info.fallback && !this.resolved) {
      this.resolved = protocol;
      this.logger.info(
        {
          event: "offramp.protocol",
          protocol,
          preference: this.preference,
          declared: (Object.entries(capabilities(info)) as [string, boolean][]).filter(([, on]) => on).map(([k]) => k),
        },
        `off-ramp protocol: ${protocol}`,
      );
    }
    return protocol;
  }

  private async adapter(): Promise<OffRampPort> {
    return (await this.protocol()) === "sep24" ? this.sep24 : this.sep6;
  }

  async offrampRequirements(assetCode: string, customer?: AnchorCustomer): Promise<OfframpRequirementTypes> {
    return (await this.adapter()).offrampRequirements(assetCode, customer);
  }

  async quote(
    input: Parameters<OffRampPort["quote"]>[0],
    opts?: { logger?: Logger },
  ): Promise<OffRampQuote> {
    return (await this.adapter()).quote(input, opts);
  }

  async initiate(
    input: { linkId: string; quoteId: string; payout: SellerPayoutRef; customer: AnchorCustomer },
    opts?: { logger?: Logger },
  ): Promise<OffRampInitiation> {
    return (await this.adapter()).initiate(input, opts);
  }

  async status(jobId: string, opts?: { logger?: Logger }): Promise<OffRampJob> {
    const job = await this.state.getJob(jobId);
    if (!job) throw new OffRampJobNotFoundError(jobId);
    const adapter = protocolOfJob(job.anchor) === "sep24" ? this.sep24 : this.sep6;
    return adapter.status(jobId, opts);
  }

  /**
   * SEP-38 GET /prices has nothing to do with which transfer protocol is used,
   * and only the SEP-6 adapter implements it; it answers from the anchor's
   * `ANCHOR_QUOTE_SERVER` alone (an empty list when there is none).
   */
  async indicativePrices(input: { sourceAsset: AssetRef; sourceAmount: string }): Promise<IndicativePrice[]> {
    return this.sep6.indicativePrices ? this.sep6.indicativePrices(input) : [];
  }
}
