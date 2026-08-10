import { describe, it, expect, vi } from "vitest";

// Hoisted so the module factory below can close over it — vi.mock is lifted
// above imports, so a plain const declared here would not exist yet.
const { loadAccount } = vi.hoisted(() => ({ loadAccount: vi.fn() }));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: class { loadAccount = loadAccount; } },
  };
});
import { horizonSignerFetcher, SignerLookupUnavailableError } from "../src/services/horizon-signers";

// ---------------------------------------------------------------------------
//  SEP-10 signer lookup (BUG-4.20).
//
//  `POST /auth` returned 500 on one attempt and 200 on the next, seconds apart,
//  with the same account. `fetchAccountSigners` was the only Horizon call in the
//  codebase not wrapped in the retry policy, so a single transient `fetch
//  failed` propagated out of the login route as an opaque 500 — sign-in worked
//  or didn't depending on the weather.
//
//  Surfaced to the user as "Something went wrong on the server."
// ---------------------------------------------------------------------------

const ACCOUNT = "GBMDH3QWSD74ILWD2ZVFOAOCMVRNPNGAHN557WA4KABLI5IFN2XYLMGY";

/** Horizon's shape for a 404, which the SDK surfaces as `response.status`. */
function notFound() {
  return Object.assign(new Error("Not Found"), { response: { status: 404 } });
}

describe("horizonSignerFetcher", () => {
  it("retries a transient network failure instead of failing the login", async () => {
    loadAccount.mockReset();
    let calls = 0;
    loadAccount.mockImplementation(async () => {
      if (++calls === 1) throw new Error("fetch failed");
      return {
        signers: [{ type: "ed25519_public_key", key: ACCOUNT, weight: 1 }],
        thresholds: { med_threshold: 0 },
      };
    });

    const fetcher = horizonSignerFetcher("https://horizon.test");
    const result = await fetcher(ACCOUNT);

    expect(loadAccount).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ signers: { [ACCOUNT]: 1 }, medThreshold: 0 });
  });

  it("throws SignerLookupUnavailableError once retries are exhausted", async () => {
    loadAccount.mockReset();
    loadAccount.mockImplementation(async () => {
      throw new Error("fetch failed");
    });

    const fetcher = horizonSignerFetcher("https://horizon.test");

    // A distinct type so the route can answer 503 "try again" rather than a
    // bare 500, which tells the caller to go looking for a fault that is ours.
    let caught: unknown;
    try {
      await fetcher(ACCOUNT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SignerLookupUnavailableError);
    expect(loadAccount).toHaveBeenCalledTimes(3);
  });

  it("treats 404 as an unfunded account and does not retry it", async () => {
    // The master-key fallback path. 4xx is terminal, so this must cost exactly
    // one attempt — retrying a definitive answer only slows login down.
    loadAccount.mockReset();
    loadAccount.mockImplementation(async () => {
      throw notFound();
    });

    const fetcher = horizonSignerFetcher("https://horizon.test");

    await expect(fetcher(ACCOUNT)).resolves.toBeNull();
    // 4xx is terminal — exactly one attempt, no backoff spent on a definitive answer.
    expect(loadAccount).toHaveBeenCalledTimes(1);
  });

  it("drops zero-weight and non-ed25519 signers", async () => {
    loadAccount.mockReset();
    loadAccount.mockResolvedValue({
      signers: [
        { type: "ed25519_public_key", key: ACCOUNT, weight: 2 },
        { type: "ed25519_public_key", key: "GREVOKED", weight: 0 },
        { type: "sha256_hash", key: "Xhash", weight: 5 },
      ],
      thresholds: { med_threshold: 2 },
    });

    const fetcher = horizonSignerFetcher("https://horizon.test");
    const result = await fetcher(ACCOUNT);

    expect(result).toEqual({ signers: { [ACCOUNT]: 2 }, medThreshold: 2 });
  });
});
