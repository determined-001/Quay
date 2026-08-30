import { Horizon } from "@stellar/stellar-sdk";
import { withHorizonRetry } from "@checkout/stellar";
import type { AccountSigners, FetchAccountSigners } from "./challenge";

/**
 * Default `FetchAccountSigners` for `ChallengeService`: looks up an account's
 * ed25519 signers and medium threshold on Horizon, for the SEP-10 M-of-N check.
 *
 * Goes through `withHorizonRetry` like every other Horizon call in the codebase.
 * It did not, and that made login intermittently fail: a single transient
 * `fetch failed` propagated out of `POST /auth` as an opaque 500, so signing in
 * worked or didn't depending on the weather. Observed alternating 500/200 on
 * consecutive attempts with the same account.
 *
 * A 404 still means "unfunded account" and returns null for the master-key
 * fallback — `isRetryable` treats 4xx as terminal, so that path is unchanged and
 * costs no extra attempts.
 */
export function horizonSignerFetcher(horizonUrl: string): FetchAccountSigners {
  const server = new Horizon.Server(horizonUrl);
  return async (accountId: string): Promise<AccountSigners> => {
    try {
      const account = await withHorizonRetry(() => server.loadAccount(accountId));
      const signers: Record<string, number> = {};
      for (const s of account.signers) {
        if (s.type === "ed25519_public_key" && s.weight > 0) signers[s.key] = s.weight;
      }
      return { signers, medThreshold: account.thresholds.med_threshold };
    } catch (err) {
      if (isNotFound(err)) return null; // unfunded account — not yet on-chain
      // Retries are already exhausted by here. Surface it as its own type so
      // the auth route can answer 503 instead of a bare 500.
      throw new SignerLookupUnavailableError(err);
    }
  };
}

/**
 * Horizon could not be reached to resolve an account's signers. Distinct from
 * "the challenge was invalid": nothing is wrong with the caller's request, and
 * retrying later is the correct response — which a 500 does not communicate.
 */
export class SignerLookupUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Could not reach Horizon to resolve account signers: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SignerLookupUnavailableError";
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === "NotFoundError";
}
