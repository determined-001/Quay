import { Horizon, StrKey } from "@stellar/stellar-sdk";
import type { AssetRef, PaymentRequest, RailPort } from "@checkout/core";
import { buildSep7PayUri, CannotReceiveError, isNative } from "@checkout/core";
import type { StellarConfig } from "./asset";
import { buildChangeTrustUri } from "./trustline-uri";
import { checkBalance, findAssetBalance, messageFor } from "./trustline-check";

interface CacheEntry {
  expiresAt: number;
  error: CannotReceiveError | null; // null = "can receive", cached as a pass
}

const PREFLIGHT_CACHE_TTL_MS = 60_000;

/** Non-custodial settlement rail: the payer pays the seller's wallet directly,
 *  with the link reference carried as the MEMO_TEXT so we can correlate it. */
export class StellarRail implements RailPort {
  private readonly server: Horizon.Server;
  private readonly preflightCache = new Map<string, CacheEntry>();

  constructor(private readonly cfg: StellarConfig) {
    this.server = new Horizon.Server(cfg.horizonUrl);
  }

  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    message?: string;
  }): PaymentRequest {
    const uri = buildSep7PayUri({
      destination: input.destination,
      amount: input.amount,
      asset: input.asset,
      memo: input.reference,
      memoType: "MEMO_TEXT",
      message: input.message,
      networkPassphrase: this.cfg.networkPassphrase,
    });
    return {
      uri,
      destination: input.destination,
      amount: input.amount,
      asset: input.asset,
      memo: input.reference,
    };
  }

  isValidDestination(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }

  async assertCanReceive(account: string, asset: AssetRef): Promise<void> {
    const cacheKey = `${account}:${asset.code}:${asset.issuer ?? "native"}`;
    const cached = this.preflightCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.error) throw cached.error;
      return;
    }

    try {
      await this.checkCanReceive(account, asset);
      this.preflightCache.set(cacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, error: null });
    } catch (err) {
      if (err instanceof CannotReceiveError) {
        this.preflightCache.set(cacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, error: err });
      }
      throw err;
    }
  }

  private async checkCanReceive(account: string, asset: AssetRef): Promise<void> {
    // Typed from loadAccount's own return, not a guessed SDK type-export path —
    // the exact Horizon.* namespace for this has moved between SDK versions.
    let horizonAccount: Awaited<ReturnType<Horizon.Server["loadAccount"]>>;
    try {
      horizonAccount = await this.server.loadAccount(account);
    } catch (err) {
      if (isNotFound(err)) {
        throw new CannotReceiveError("account_not_found", messageFor("account_not_found", account, asset));
      }
      throw err;
    }

    // Native XLM needs no trustline; the account already existing (above) is the whole check.
    if (isNative(asset)) return;

    const balance = findAssetBalance(horizonAccount.balances, asset);
    const reason = checkBalance(balance, asset);
    if (reason === null) return;

    const trustlineUri = reason === "no_trustline" ? buildChangeTrustUri(horizonAccount, asset, this.cfg.networkPassphrase) : undefined;
    throw new CannotReceiveError(reason, messageFor(reason, account, asset, balance), trustlineUri);
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}
