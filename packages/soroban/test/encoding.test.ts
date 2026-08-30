import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assetCodeBytes,
  assetCodeFromBytes,
  refHash,
  refHashHex,
  txHashBytes,
} from "../src/encoding";

// The registry is append-only: a byte encoded wrongly here is wrong on-chain
// forever, and no later release can correct it. These tests pin the wire format
// against independent computations rather than against the implementation.

describe("refHash", () => {
  it("is plain sha256 of the UTF-8 reference", () => {
    const reference = "pl_29r3eixyibf0";
    const independent = createHash("sha256").update(reference, "utf8").digest("hex");
    expect(refHashHex(reference)).toBe(independent);
    expect(refHash(reference)).toHaveLength(32);
  });

  it("matches the digest a third party computes from the reference alone", () => {
    // Verification only works if someone holding a receipt can recompute this
    // key without any Quay-specific knowledge. Hard-coded so a change to the
    // hashing (encoding, salting, casing) fails loudly instead of silently
    // orphaning every attestation ever written.
    expect(refHashHex("ref_1")).toBe(
      "0ad9093bdc61b90e7ef911eb754f2755f52d27adcee86b369302a9b0fca59cc1",
    );
  });

  it("does not collide across distinct references", () => {
    expect(refHashHex("ref_1")).not.toBe(refHashHex("ref_2"));
  });
});

describe("txHashBytes", () => {
  const valid = "404af243b9f4007b58fee6cc7d1c3061aa1a8db145eff1f9b4bb1abdfd87bf00";

  it("decodes a 64-character hex hash to 32 raw bytes", () => {
    const bytes = txHashBytes(valid);
    expect(bytes).toHaveLength(32);
    expect(bytes.toString("hex")).toBe(valid);
  });

  it("accepts uppercase hex", () => {
    expect(txHashBytes(valid.toUpperCase()).toString("hex")).toBe(valid);
  });

  it.each([
    ["truncated", valid.slice(0, 63)],
    ["over-long", `${valid}00`],
    ["non-hex", `${valid.slice(0, 63)}z`],
    ["empty", ""],
  ])("rejects a %s hash rather than writing it", (_label, input) => {
    expect(() => txHashBytes(input)).toThrow(/64-character hex/);
  });
});

describe("assetCodeBytes", () => {
  it("right-pads a 4-character code to 12 bytes with zeros", () => {
    const bytes = assetCodeBytes("USDC");
    expect(bytes).toHaveLength(12);
    expect([...bytes]).toEqual([0x55, 0x53, 0x44, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("fills the full width for a 12-character code", () => {
    const bytes = assetCodeBytes("ABCDEFGHIJKL");
    expect(bytes.toString("utf8")).toBe("ABCDEFGHIJKL");
  });

  it("rejects a code longer than Stellar allows instead of truncating", () => {
    expect(() => assetCodeBytes("ABCDEFGHIJKLM")).toThrow(/1-12 bytes/);
  });

  it("rejects an empty code", () => {
    expect(() => assetCodeBytes("")).toThrow(/1-12 bytes/);
  });

  it.each(["XLM", "USDC", "NGNC", "ABCDEFGHIJKL"])("round-trips %s", (code) => {
    expect(assetCodeFromBytes(assetCodeBytes(code))).toBe(code);
  });
});
