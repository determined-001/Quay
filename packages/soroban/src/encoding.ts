import { createHash } from "node:crypto";

/**
 * Pure encoders between Quay's domain shapes and the argument types
 * `contracts/quay-attest` expects. Kept apart from the RPC client so the wire
 * format — the part a wrong byte silently corrupts forever, since the registry
 * is append-only — is testable without a network.
 */

/**
 * `sha256(reference)`, the contract's storage key.
 *
 * The reference is the Stellar memo and is effectively an invoice id, so
 * writing it in the clear would publish a seller's invoice volume and sequence
 * to anyone reading contract storage. Hashing keeps the registry verifiable by
 * anyone *given* a reference and opaque to everyone else. UTF-8 is fixed here
 * on purpose: the digest must be reproducible by an independent verifier from
 * the reference string alone.
 */
export function refHash(reference: string): Buffer {
  return createHash("sha256").update(reference, "utf8").digest();
}

/** Hex digest of {@link refHash}, for logs, receipts and CLI verification. */
export function refHashHex(reference: string): string {
  return refHash(reference).toString("hex");
}

/**
 * A classic transaction hash as the 32 raw bytes the contract stores.
 * Rejects anything that isn't exactly 64 hex characters — a truncated or
 * mistyped hash written here can never be corrected.
 */
export function txHashBytes(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`Expected a 64-character hex transaction hash, got "${hex}"`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * An asset code as `BytesN<12>`, right-padded with zeros — `USDC` becomes
 * `b"USDC\0\0\0\0\0\0\0\0"`. Stellar itself allows at most 12 characters, so a
 * longer code is a bug rather than something to truncate.
 */
export function assetCodeBytes(code: string): Buffer {
  const raw = Buffer.from(code, "utf8");
  if (raw.length === 0 || raw.length > 12) {
    throw new Error(`Asset code must be 1-12 bytes, got "${code}" (${raw.length})`);
  }
  const padded = Buffer.alloc(12);
  raw.copy(padded);
  return padded;
}

/** Decode a `BytesN<12>` asset code back to its string form. */
export function assetCodeFromBytes(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return Buffer.from(bytes.subarray(0, end)).toString("utf8");
}
