import { describe, it, expect, beforeEach } from "vitest";


// A fixed 32-byte key so tests are deterministic and don't depend on the
// insecure dev-fallback warning path.
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "0".repeat(64);

const { encryptSecret, decryptSecret, last4, assertKeyConfigured, __resetKeyCacheForTests } = await import(
  "../src/services/secret-crypto"
);

beforeEach(() => {
  __resetKeyCacheForTests();
});

describe("secret-crypto", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const secret = "wh_sec_" + "a".repeat(48);
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces different ciphertext for the same secret each time (random IV)", () => {
    const secret = "same-secret-value";
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(secret);
    expect(decryptSecret(b)).toBe(secret);
  });

  it("rejects a malformed ciphertext", () => {
    expect(() => decryptSecret("not-a-valid-ciphertext")).toThrow(/Malformed/);
  });

  it("rejects ciphertext tampering (auth tag mismatch)", () => {
    const encrypted = encryptSecret("secret-value");
    const [iv, tag, data] = encrypted.split(".");
    const tamperedData = Buffer.from(data ?? "", "base64url");
    tamperedData[0] = (tamperedData[0] ?? 0) ^ 0xff;
    const tampered = [iv, tag, tamperedData.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("returns the last 4 characters for display", () => {
    expect(last4("0123456789abcdef")).toBe("cdef");
  });

  it("rejects an encryption key that is the wrong length", () => {
    __resetKeyCacheForTests();
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "0".repeat(64);
    __resetKeyCacheForTests();
  });

  // Regression, BUG-4.11: key resolution used to be reached only when a seller
  // first registered a webhook, so a production deploy with no
  // WEBHOOK_SECRET_ENCRYPTION_KEY booted green and 500'd on a customer request
  // hours later. createContainer() now calls assertKeyConfigured() at boot.
  describe("assertKeyConfigured (boot-time fail-fast)", () => {
    const restore = (nodeEnv: string | undefined, key: string | undefined) => {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (key === undefined) delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
      else process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = key;
      __resetKeyCacheForTests();
    };

    it("throws in production when the key is missing", () => {
      const prevEnv = process.env.NODE_ENV;
      const prevKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
      __resetKeyCacheForTests();
      delete process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
      process.env.NODE_ENV = "production";

      expect(() => assertKeyConfigured()).toThrow(/WEBHOOK_SECRET_ENCRYPTION_KEY is required in production/);

      restore(prevEnv, prevKey);
    });

    it("throws in production when the key is present but malformed", () => {
      const prevEnv = process.env.NODE_ENV;
      const prevKey = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
      __resetKeyCacheForTests();
      process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "tooshort";
      process.env.NODE_ENV = "production";

      expect(() => assertKeyConfigured()).toThrow(/32 bytes/);

      restore(prevEnv, prevKey);
    });

    it("resolves quietly when a valid key is configured", () => {
      __resetKeyCacheForTests();
      process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "0".repeat(64);
      expect(() => assertKeyConfigured()).not.toThrow();
    });
  });
});
