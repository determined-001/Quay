import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { parseSignatureHeader, verifySep12CallbackSignature } from "../src/sep12-callback";

describe("SEP-12 Callback Signature Verification", () => {
  const anchorKeypair = Keypair.random();
  const host = "api.example.com";
  const body = JSON.stringify({ id: "cust_123", status: "ACCEPTED" });

  function makeSignatureHeader(kp: Keypair, timestamp: number, h: string, b: string): string {
    const payload = `${timestamp}.${h}.${b}`;
    const sig = kp.sign(Buffer.from(payload, "utf8")).toString("base64");
    return `t=${timestamp}, s=${sig}`;
  }

  it("parses valid signature headers", () => {
    expect(parseSignatureHeader("t=1700000000, s=YWJjZA==")).toEqual({
      t: 1700000000,
      s: "YWJjZA==",
    });
    expect(parseSignatureHeader("s=YWJjZA==,t=1700000000")).toEqual({
      t: 1700000000,
      s: "YWJjZA==",
    });
    expect(parseSignatureHeader("t=invalid, s=YWJjZA==")).toBeNull();
    expect(parseSignatureHeader("t=-10, s=YWJjZA==")).toBeNull();
    expect(parseSignatureHeader("invalid")).toBeNull();
  });

  it("verifies a valid signature successfully", () => {
    const now = 1700000000;
    const header = makeSignatureHeader(anchorKeypair, now, host, body);

    const valid = verifySep12CallbackSignature({
      header,
      body,
      host,
      signingKey: anchorKeypair.publicKey(),
      now,
    });

    expect(valid).toBe(true);
  });

  it("rejects when timestamp skew exceeds max allowed", () => {
    const now = 1700000000;
    const oldHeader = makeSignatureHeader(anchorKeypair, now - 150, host, body);
    const futureHeader = makeSignatureHeader(anchorKeypair, now + 150, host, body);

    expect(
      verifySep12CallbackSignature({
        header: oldHeader,
        body,
        host,
        signingKey: anchorKeypair.publicKey(),
        now,
        maxSkewSeconds: 120,
      }),
    ).toBe(false);

    expect(
      verifySep12CallbackSignature({
        header: futureHeader,
        body,
        host,
        signingKey: anchorKeypair.publicKey(),
        now,
        maxSkewSeconds: 120,
      }),
    ).toBe(false);
  });

  it("rejects when signed with a different keypair", () => {
    const anotherKeypair = Keypair.random();
    const now = 1700000000;
    const header = makeSignatureHeader(anotherKeypair, now, host, body);

    const valid = verifySep12CallbackSignature({
      header,
      body,
      host,
      signingKey: anchorKeypair.publicKey(),
      now,
    });

    expect(valid).toBe(false);
  });

  it("rejects when host or body is tampered", () => {
    const now = 1700000000;
    const header = makeSignatureHeader(anchorKeypair, now, host, body);

    expect(
      verifySep12CallbackSignature({
        header,
        body: JSON.stringify({ id: "cust_123", status: "REJECTED" }),
        host,
        signingKey: anchorKeypair.publicKey(),
        now,
      }),
    ).toBe(false);

    expect(
      verifySep12CallbackSignature({
        header,
        body,
        host: "evil.example.com",
        signingKey: anchorKeypair.publicKey(),
        now,
      }),
    ).toBe(false);
  });
});
