import { Keypair } from "@stellar/stellar-sdk";

export interface VerifySep12CallbackParams {
  /**
   * The signature header value from `Signature` or `X-Stellar-Signature`.
   * Format: `t=<timestamp>, s=<base64_signature>` (or `t=<timestamp>,s=<base64_signature>`).
   */
  header: string | null | undefined;
  /** The raw UTF-8 request body text. */
  body: string;
  /** The Host header from the request (e.g. `api.example.com` or `localhost:8787`). */
  host: string;
  /** The anchor's published SIGNING_KEY (G... public key) from stellar.toml. */
  signingKey: string;
  /** Current time in seconds since epoch. Defaults to `Math.floor(Date.now() / 1000)`. */
  now?: number;
  /** Max allowed clock skew in seconds (default 120s). */
  maxSkewSeconds?: number;
}

export function parseSignatureHeader(header: string): { t: number; s: string } | null {
  // Matches t=<digits>, s=<base64> in either order, with optional spaces
  const parts = header.split(",").map((p) => p.trim());
  let tStr: string | undefined;
  let sStr: string | undefined;

  for (const part of parts) {
    if (part.startsWith("t=")) {
      tStr = part.slice(2).trim();
    } else if (part.startsWith("s=")) {
      sStr = part.slice(2).trim();
    }
  }

  if (!tStr || !sStr) return null;
  const t = Number(tStr);
  if (!Number.isFinite(t) || t <= 0) return null;

  return { t, s: sStr };
}

/**
 * Verifies that a SEP-12 KYC callback POST is authentic, signed with the anchor's SIGNING_KEY.
 *
 * Payload signed is: `<timestamp>.<host>.<body>`
 *
 * Returns `true` if signature is valid and within allowable clock skew, `false` otherwise.
 */
export function verifySep12CallbackSignature(params: VerifySep12CallbackParams): boolean {
  if (!params.header || !params.signingKey || !params.host) return false;

  const parsed = parseSignatureHeader(params.header);
  if (!parsed) return false;

  const now = params.now ?? Math.floor(Date.now() / 1000);
  const maxSkew = params.maxSkewSeconds ?? 120;

  if (Math.abs(now - parsed.t) > maxSkew) {
    return false;
  }

  const payload = `${parsed.t}.${params.host}.${params.body}`;

  try {
    const keypair = Keypair.fromPublicKey(params.signingKey);
    const signatureBuffer = Buffer.from(parsed.s, "base64");
    return keypair.verify(Buffer.from(payload, "utf8"), signatureBuffer);
  } catch {
    return false;
  }
}
