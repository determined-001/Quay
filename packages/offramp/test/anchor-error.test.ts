import { describe, expect, it } from "vitest";
import {
  ANCHOR_ERROR_BODY_MAX_BYTES,
  AnchorHttpError,
  anchorErrorSummary,
  anchorHttpError,
  anchorRejectionDetail,
  isAnchorRejection,
  getSep6Info,
  truncateAnchorBody,
} from "../src";

describe("AnchorHttpError", () => {
  it("keeps the anchor's body out of the message", () => {
    const err = new AnchorHttpError({ sep: "6", op: "withdraw", status: 400, body: "SECRET-MARKER bank 123456" });
    expect(err.message).toBe("SEP-6 withdraw failed: 400");
    expect(err.message).not.toContain("SECRET-MARKER");
    expect(err.body).toBe("SECRET-MARKER bank 123456");
    expect(err).toMatchObject({ sep: "6", op: "withdraw", status: 400 });
  });

  it("truncates a large body to about 2 KB", () => {
    const err = new AnchorHttpError({ sep: "12", op: "customer PUT", status: 500, body: "x".repeat(50_000) });
    expect(new TextEncoder().encode(err.body).length).toBeLessThan(ANCHOR_ERROR_BODY_MAX_BYTES + 32);
    expect(err.body.endsWith("[truncated]")).toBe(true);
  });

  it("does not split a multi-byte character when truncating", () => {
    const out = truncateAnchorBody("é".repeat(5000), 101);
    expect(out).not.toContain("�");
  });

  it("leaves a short body untouched", () => {
    expect(truncateAnchorBody("short")).toBe("short");
  });

  it("gives a client-safe summary with no body", () => {
    const err = new AnchorHttpError({ sep: "6", op: "withdraw", status: 400, body: "SECRET-MARKER" });
    expect(anchorErrorSummary(err)).toBe("The anchor returned an error (SEP-6 withdraw, HTTP 400).");
  });

  it("is built from a failed response, tolerating an unreadable body", async () => {
    const ok = await anchorHttpError("38", "quote", new Response("<html>boom</html>", { status: 503 }));
    expect(ok.status).toBe(503);
    expect(ok.body).toBe("<html>boom</html>");

    const res = new Response("x", { status: 502 });
    res.text = () => Promise.reject(new Error("stream broke"));
    expect((await anchorHttpError("38", "quote", res)).body).toBe("");
  });
});

describe("SEP clients throw AnchorHttpError", () => {
  it("SEP-6 /info reports the status and keeps the body separate", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("SECRET-MARKER internal-host.corp", { status: 503 })) as typeof fetch;
    try {
      const err = await getSep6Info("https://anchor-error.test").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AnchorHttpError);
      expect((err as AnchorHttpError).message).toBe("SEP-6 /info failed: 503");
      expect((err as AnchorHttpError).message).not.toContain("SECRET-MARKER");
      expect((err as AnchorHttpError).body).toContain("SECRET-MARKER");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("isAnchorRejection / anchorRejectionDetail", () => {
  const err = (sep: "6" | "38" | "12", op: string, status: number, body = "") =>
    new AnchorHttpError({ sep, op, status, body });

  it("is true for a 400, 403 or 422 on SEP-6 withdraw or the SEP-38 quote", () => {
    for (const status of [400, 403, 422]) {
      expect(isAnchorRejection(err("6", "withdraw", status))).toBe(true);
      expect(isAnchorRejection(err("38", "quote", status))).toBe(true);
    }
  });

  it("is false for 5xx, 429, other calls and non-anchor errors", () => {
    for (const status of [429, 500, 502, 503, 404]) {
      expect(isAnchorRejection(err("6", "withdraw", status))).toBe(false);
    }
    expect(isAnchorRejection(err("12", "customer PUT", 400))).toBe(false);
    expect(isAnchorRejection(err("6", "/info", 400))).toBe(false);
    expect(isAnchorRejection(new Error("400"))).toBe(false);
  });

  it("returns only the type and well-formed field names", () => {
    const body = JSON.stringify({
      type: "non_interactive_customer_info_needed",
      fields: ["first_name", "bad field", 7, "email_address"],
      error: "free text that may echo KYC data",
    });
    expect(anchorRejectionDetail(err("6", "withdraw", 400, body))).toEqual({
      anchorType: "non_interactive_customer_info_needed",
      fields: ["first_name", "email_address"],
    });
  });

  it("returns nothing for a non-JSON, non-object or oddly typed body", () => {
    expect(anchorRejectionDetail(err("6", "withdraw", 400, "<html>nope</html>"))).toEqual({});
    expect(anchorRejectionDetail(err("6", "withdraw", 400, "null"))).toEqual({});
    expect(anchorRejectionDetail(err("6", "withdraw", 400, JSON.stringify({ type: "has spaces", fields: [] })))).toEqual({});
  });
});
