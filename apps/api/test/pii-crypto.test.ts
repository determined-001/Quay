import { randomBytes, createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeKeyId,
  parsePiiKey,
  parsePiiKeyring,
  getBlobKeyId,
  encryptPii,
  decryptPii,
} from "../src/crypto/pii";

describe("PII Crypto & Keyring", () => {
  const key1 = randomBytes(32);
  const key1Hex = key1.toString("hex");
  const key2 = randomBytes(32);
  const key2Hex = key2.toString("hex");
  const key3 = randomBytes(32);
  const key3Hex = key3.toString("hex");

  describe("computeKeyId", () => {
    it("returns the first 8 hex characters of the sha256 digest of the key", () => {
      const id = computeKeyId(key1);
      expect(id).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(id)).toBe(true);
    });
  });

  describe("parsePiiKey", () => {
    it("parses 64-char hex string into 32-byte Buffer", () => {
      const buf = parsePiiKey(key1Hex);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(32);
      expect(buf.equals(key1)).toBe(true);
    });

    it("throws on invalid hex length or characters", () => {
      expect(() => parsePiiKey("abcd")).toThrow(/KYC_ENCRYPTION_KEY must be 32 bytes/);
      expect(() => parsePiiKey("g".repeat(64))).toThrow(/KYC_ENCRYPTION_KEY must be 32 bytes/);
    });
  });

  describe("parsePiiKeyring", () => {
    it("parses primary key and previous keys", () => {
      const keyring = parsePiiKeyring(key1Hex, `${key2Hex}, ${key3Hex}`);
      expect(keyring.primary.key.equals(key1)).toBe(true);
      expect(keyring.primary.id).toBe(computeKeyId(key1));
      expect(keyring.previous).toHaveLength(2);
      expect(keyring.all.size).toBe(3);
      expect(keyring.all.get(computeKeyId(key1))?.equals(key1)).toBe(true);
      expect(keyring.all.get(computeKeyId(key2))?.equals(key2)).toBe(true);
      expect(keyring.all.get(computeKeyId(key3))?.equals(key3)).toBe(true);
    });

    it("handles empty or whitespace previous keys", () => {
      const keyring = parsePiiKeyring(key1Hex, "  ,  ");
      expect(keyring.previous).toHaveLength(0);
      expect(keyring.all.size).toBe(1);
    });
  });

  describe("getBlobKeyId", () => {
    it("returns keyId for versioned blobs", () => {
      const id = computeKeyId(key1);
      expect(getBlobKeyId(`v1:${id}:somebase64`)).toBe(id);
    });

    it("returns legacy for unprefixed blobs", () => {
      expect(getBlobKeyId("dGVzdA==")).toBe("legacy");
    });
  });

  describe("encryptPii and decryptPii", () => {
    const plaintext = JSON.stringify({ first_name: "Alice", last_name: "Smith", ssn: "123-45-6789" });

    it("encrypts to versioned format v1:<keyId>:<base64>", () => {
      const blob = encryptPii(plaintext, key1);
      const id = computeKeyId(key1);
      expect(blob.startsWith(`v1:${id}:`)).toBe(true);
      expect(getBlobKeyId(blob)).toBe(id);
    });

    it("round-trips encryption and decryption with Buffer key", () => {
      const blob = encryptPii(plaintext, key1);
      const decrypted = decryptPii(blob, key1);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips encryption and decryption with PiiKeyring", () => {
      const keyring = parsePiiKeyring(key1Hex, key2Hex);
      const blob = encryptPii(plaintext, keyring);
      const decrypted = decryptPii(blob, keyring);
      expect(decrypted).toBe(plaintext);
    });

    it("decrypts blobs encrypted under previous keys in the keyring", () => {
      const oldKeyring = parsePiiKeyring(key2Hex);
      const newKeyring = parsePiiKeyring(key1Hex, key2Hex);

      const oldBlob = encryptPii(plaintext, oldKeyring);
      expect(getBlobKeyId(oldBlob)).toBe(computeKeyId(key2));

      const decrypted = decryptPii(oldBlob, newKeyring);
      expect(decrypted).toBe(plaintext);
    });

    it("throws when decrypting with an unknown key ID", () => {
      const blob = encryptPii(plaintext, key1);
      const otherKeyring = parsePiiKeyring(key2Hex);
      expect(() => decryptPii(blob, otherKeyring)).toThrow(/Unknown KYC encryption key id/);
    });

    it("decrypts legacy unprefixed base64 blobs", () => {
      // Create legacy blob: base64(iv(12) || authTag(16) || ciphertext)
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key2, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const legacyBlob = Buffer.concat([iv, authTag, ciphertext]).toString("base64");

      expect(getBlobKeyId(legacyBlob)).toBe("legacy");

      const keyring = parsePiiKeyring(key1Hex, key2Hex);
      const decrypted = decryptPii(legacyBlob, keyring);
      expect(decrypted).toBe(plaintext);
    });

    it("fails closed on tampering with versioned blob", () => {
      const blob = encryptPii(plaintext, key1);
      const parts = blob.split(":");
      const raw = Buffer.from(parts[2]!, "base64");
      raw[raw.length - 1]! ^= 0x01; // flip last bit
      const tampered = `v1:${parts[1]}:${raw.toString("base64")}`;

      expect(() => decryptPii(tampered, key1)).toThrow();
    });
  });
});
