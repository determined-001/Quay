import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AES-256-GCM at-rest encryption for PII (SEP-12 KYC field values). Each blob
// carries its own random IV, auth tag, and key ID prefix (`v1:<keyId>:<base64>`).
// Tampering fails authentication rather than silently returning corrupted plaintext.
// Key rotation is supported via a PiiKeyring containing the primary key and
// previous keys for decryption.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

export interface PiiKey {
  id: string; // 8-char hex prefix of sha256(key)
  key: Buffer;
}

export interface PiiKeyring {
  primary: PiiKey;
  all: Map<string, Buffer>;
  previous: PiiKey[];
}

/** Computes the key ID (first 8 hex characters of SHA-256 of the key). */
export function computeKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Parses KYC_ENCRYPTION_KEY (64 hex chars = 32 bytes) into a usable key Buffer. */
export function parsePiiKey(hex: string): Buffer {
  const trimmed = hex.trim();
  const key = Buffer.from(trimmed, "hex");
  if (key.length !== 32 || !/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      `KYC_ENCRYPTION_KEY must be 32 bytes as hex (64 hex chars), got ${key.length} bytes. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return key;
}

/** Parses primary key and optional comma-separated previous keys into a PiiKeyring. */
export function parsePiiKeyring(
  primaryHex: string,
  previousHexList?: string,
): PiiKeyring {
  const primaryBuf = parsePiiKey(primaryHex);
  const primaryId = computeKeyId(primaryBuf);
  const primary: PiiKey = { id: primaryId, key: primaryBuf };

  const all = new Map<string, Buffer>();
  all.set(primaryId, primaryBuf);

  const previous: PiiKey[] = [];
  if (previousHexList && previousHexList.trim().length > 0) {
    const rawKeys = previousHexList.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const hex of rawKeys) {
      const keyBuf = parsePiiKey(hex);
      const id = computeKeyId(keyBuf);
      if (!all.has(id)) {
        all.set(id, keyBuf);
        previous.push({ id, key: keyBuf });
      }
    }
  }

  return { primary, all, previous };
}

/** Extracts the key ID from a blob, returning "legacy" if unprefixed. */
export function getBlobKeyId(blob: string): string | "legacy" {
  if (blob.startsWith("v1:")) {
    const parts = blob.split(":");
    if (parts.length === 3 && parts[1]) {
      return parts[1];
    }
  }
  return "legacy";
}

/** Encrypts `plaintext`, returning a versioned blob: `v1:<keyId>:<base64(iv||authTag||ciphertext)>`. */
export function encryptPii(plaintext: string, keyOrKeyring: Buffer | PiiKeyring): string {
  const key = Buffer.isBuffer(keyOrKeyring) ? keyOrKeyring : keyOrKeyring.primary.key;
  const keyId = Buffer.isBuffer(keyOrKeyring) ? computeKeyId(keyOrKeyring) : keyOrKeyring.primary.id;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const rawBase64 = Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  return `v1:${keyId}:${rawBase64}`;
}

/** Inverse of {@link encryptPii}. Supports versioned blobs and legacy unprefixed blobs. */
export function decryptPii(blob: string, keyOrKeyring: Buffer | PiiKeyring): string {
  if (blob.startsWith("v1:")) {
    const parts = blob.split(":");
    if (parts.length !== 3 || !parts[1] || !parts[2]) {
      throw new Error("Invalid KYC encryption blob format");
    }
    const keyId = parts[1];
    const payloadBase64 = parts[2];

    let key: Buffer | undefined;
    if (Buffer.isBuffer(keyOrKeyring)) {
      if (computeKeyId(keyOrKeyring) === keyId) {
        key = keyOrKeyring;
      }
    } else {
      key = keyOrKeyring.all.get(keyId);
    }

    if (!key) {
      throw new Error(`Unknown KYC encryption key id: ${keyId}`);
    }

    const raw = Buffer.from(payloadBase64, "base64");
    if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error("Invalid KYC ciphertext payload length");
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  // Legacy unprefixed blob (base64 of iv || authTag || ciphertext)
  const keysToTry: Buffer[] = [];
  if (Buffer.isBuffer(keyOrKeyring)) {
    keysToTry.push(keyOrKeyring);
  } else {
    keysToTry.push(keyOrKeyring.primary.key);
    for (const p of keyOrKeyring.previous) {
      keysToTry.push(p.key);
    }
  }

  let lastError: unknown;
  for (const k of keysToTry) {
    try {
      const raw = Buffer.from(blob, "base64");
      if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error("Invalid KYC ciphertext payload length");
      }
      const iv = raw.subarray(0, IV_LENGTH);
      const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, k, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? new Error("Failed to decrypt legacy KYC blob with configured key(s)")
    : new Error("Failed to decrypt legacy KYC blob");
}
