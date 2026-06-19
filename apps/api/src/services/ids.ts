import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function base36(bytes: Buffer): string {
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

/** Prefixed internal id, e.g. "lnk_3f9k2a7q1z". */
export function newId(prefix: string): string {
  return `${prefix}_${base36(randomBytes(10))}`;
}

/**
 * On-chain correlation reference, embedded as the Stellar MEMO_TEXT.
 * Must stay <= 28 bytes. Format "pl_" + 12 chars = 15 bytes. Safe.
 */
export function newReference(): string {
  return `pl_${base36(randomBytes(12))}`;
}
