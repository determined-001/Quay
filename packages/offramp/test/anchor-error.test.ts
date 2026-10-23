import { describe, expect, it } from "vitest";
import { OffRampRejectedError } from "@checkout/core";
import {
  ANCHOR_ERROR_BODY_MAX_BYTES,
  AnchorHttpError,
  AnchorRejectedError,
  anchorCallError,
  anchorErrorSummary,
  anchorHttpError,
  anchorRejectionSummary,
  getSep38Quote,
  getSep6Info,
  isAnchorRejectionStatus,
  parseAnchorRejection,
  startSep6Withdraw,
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

/** Stubs `fetch` with one answer and hands back whatever the call threw. */
async function errorFrom(status: number, body: string, call: () => Promise<unknown>): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
  try {
    return await call().then(
      () => {
        throw new Error("expected the call to reject");
      },
      (err: unknown) => err,
    );
  } finally {
    globalThis.fetch = original;
  }
}

const withdraw = () =>
  startSep6Withdraw("https://anchor-reject.test", "jwt", {
    assetCode: "USDC",
    amount: "25",
    account: "GSELLER",
    type: "bank_account",
  });

const quote = () =>
  getSep38Quote("https://anchor-reject.test", "jwt", {
    sellAsset: { code: "USDC", issuer: "G" },
    sellAmount: "25",
    buyCurrency: "NGN",
  });

describe("anchorCallError classifies the answer", () => {
  it.each([400, 403, 404, 422])("treats HTTP %i as a rejection, not an outage", async (status) => {
    const err = await anchorCallError("6", "withdraw", new Response("{}", { status }));
    expect(err).toBeInstanceOf(AnchorRejectedError);
    expect(err).toBeInstanceOf(OffRampRejectedError);
    expect(err).not.toBeInstanceOf(AnchorHttpError);
    expect((err as AnchorRejectedError).status).toBe(status);
  });

  it.each([401, 429, 500, 502, 503])("keeps HTTP %i as an anchor failure", async (status) => {
    const err = await anchorCallError("6", "withdraw", new Response("{}", { status }));
    expect(err).toBeInstanceOf(AnchorHttpError);
    expect(err).not.toBeInstanceOf(AnchorRejectedError);
  });

  it("carries the structured SEP error but never the anchor's prose in the message", async () => {
    const body = JSON.stringify({
      type: "non_interactive_customer_info_needed",
      error: "SECRET-MARKER first_name=Ada account=1234567890",
      fields: ["phone_number", "id_number"],
    });
    const err = (await anchorCallError("6", "withdraw", new Response(body, { status: 400 }))) as AnchorRejectedError;
    expect(err).toBeInstanceOf(AnchorRejectedError);
    expect(err.anchorType).toBe("non_interactive_customer_info_needed");
    expect(err.anchorFields).toEqual(["phone_number", "id_number"]);
    expect(err.anchorError).toContain("SECRET-MARKER");
    expect(err.message).toBe(anchorRejectionSummary("6", "withdraw", 400));
    expect(err.message).not.toContain("SECRET-MARKER");
    expect(err.body).toContain("SECRET-MARKER");
  });

  it("reads an HTML or non-object body as no detail at all (issue 4.36)", async () => {
    for (const body of ["<html>SECRET-MARKER</html>", '"just a string"', "[1,2,3]"]) {
      const err = (await anchorCallError("6", "withdraw", new Response(body, { status: 400 }))) as AnchorRejectedError;
      expect(err).toBeInstanceOf(AnchorRejectedError);
      expect(err.anchorType).toBeUndefined();
      expect(err.anchorError).toBeUndefined();
      expect(err.anchorFields).toBeUndefined();
      expect(err.message).not.toContain("SECRET-MARKER");
    }
  });

  it("bounds every value it carries", () => {
    const detail = parseAnchorRejection(
      JSON.stringify({
        type: "t".repeat(5_000),
        error: "e".repeat(50_000),
        fields: Array.from({ length: 200 }, () => "f".repeat(500)),
      }),
    );
    expect(new TextEncoder().encode(detail.type!).length).toBeLessThan(200);
    expect(new TextEncoder().encode(detail.error!).length).toBeLessThan(600);
    expect(detail.fields).toHaveLength(20);
    expect(detail.fields!.every((f) => new TextEncoder().encode(f).length < 100)).toBe(true);
  });

  it("ignores malformed field entries rather than carrying them", () => {
    expect(parseAnchorRejection(JSON.stringify({ type: 7, error: { nested: true }, fields: ["ok", 42, null] }))).toEqual({
      fields: ["ok"],
    });
    expect(parseAnchorRejection("")).toEqual({});
  });
});

describe("isAnchorRejectionStatus", () => {
  it("is the 4xx set the anchors answer with", () => {
    expect([400, 403, 404, 422].every(isAnchorRejectionStatus)).toBe(true);
    expect([200, 401, 409, 429, 500, 502, 503].some(isAnchorRejectionStatus)).toBe(false);
  });
});

describe("SEP-6 /withdraw and SEP-38 quote throw AnchorRejectedError", () => {
  it("SEP-6 withdraw: 400 customer_info_needed is a rejection", async () => {
    const err = await errorFrom(
      400,
      JSON.stringify({ type: "non_interactive_customer_info_needed", fields: ["phone_number"] }),
      withdraw,
    );
    expect(err).toBeInstanceOf(AnchorRejectedError);
    expect(err).toBeInstanceOf(OffRampRejectedError);
    expect(err).toMatchObject({ sep: "6", op: "withdraw", status: 400 });
    expect((err as AnchorRejectedError).anchorFields).toEqual(["phone_number"]);
  });

  it("SEP-6 withdraw: 403 customer_info_status is a rejection", async () => {
    const err = await errorFrom(403, JSON.stringify({ type: "customer_info_status" }), withdraw);
    expect(err).toBeInstanceOf(AnchorRejectedError);
    expect(err).toMatchObject({ status: 403 });
  });

  it("SEP-38 quote: 400 for an unsupported pair is a rejection", async () => {
    const err = await errorFrom(400, JSON.stringify({ error: "unsupported asset pair" }), quote);
    expect(err).toBeInstanceOf(AnchorRejectedError);
    expect(err).toMatchObject({ sep: "38", op: "quote", status: 400 });
    expect((err as AnchorRejectedError).anchorError).toBe("unsupported asset pair");
  });

  it.each([429, 502])("a %i from either call stays an outage", async (status) => {
    expect(await errorFrom(status, "upstream down", withdraw)).toBeInstanceOf(AnchorHttpError);
    expect(await errorFrom(status, "upstream down", quote)).toBeInstanceOf(AnchorHttpError);
  });

  it("a 400 from /withdraw still keeps a non-JSON body off the message", async () => {
    const err = await errorFrom(400, "<html>SECRET-MARKER</html>", withdraw);
    expect(err).toBeInstanceOf(AnchorRejectedError);
    expect((err as AnchorRejectedError).message).not.toContain("SECRET-MARKER");
    expect((err as AnchorRejectedError).body).toContain("SECRET-MARKER");
  });
});
