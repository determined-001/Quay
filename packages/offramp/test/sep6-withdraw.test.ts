import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@checkout/core";
import { startSep6Withdraw } from "../src/sep6";
import { AnchorHttpError } from "../src/anchor-error";

describe("startSep6Withdraw", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const BASE_INPUT = {
    assetCode: "USDC",
    amount: "100.50",
    account: "GAEXAMPLEACCOUNTFORSTELLARWITHDRAWALTEST1234567890",
    type: "bank_account",
  };

  it("builds the correct URL under a path-prefixed TRANSFER_SERVER and sends query params", async () => {
    let capturedUrl: URL | undefined;
    let capturedHeaders: HeadersInit | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = new URL(String(input));
        capturedHeaders = init?.headers;
        return Response.json({ id: "wd_1" });
      }),
    );

    const result = await startSep6Withdraw("https://anchor.example/sep6", "test-jwt-token", {
      ...BASE_INPUT,
      fields: {
        dest: "account_12345",
        dest_extra: "routing_67890",
      },
    });

    expect(result).toEqual({ id: "wd_1", accountId: undefined, memo: undefined, memoType: undefined });
    expect(capturedUrl).toBeDefined();
    expect(capturedUrl!.origin).toBe("https://anchor.example");
    expect(capturedUrl!.pathname).toBe("/sep6/withdraw");
    expect(capturedUrl!.searchParams.get("asset_code")).toBe("USDC");
    expect(capturedUrl!.searchParams.get("amount")).toBe("100.50");
    expect(capturedUrl!.searchParams.get("account")).toBe("GAEXAMPLEACCOUNTFORSTELLARWITHDRAWALTEST1234567890");
    expect(capturedUrl!.searchParams.get("type")).toBe("bank_account");
    expect(capturedUrl!.searchParams.get("dest")).toBe("account_12345");
    expect(capturedUrl!.searchParams.get("dest_extra")).toBe("routing_67890");

    expect(capturedHeaders).toEqual({ authorization: "Bearer test-jwt-token" });
  });

  it("correctly handles deeply nested base path and trailing slashes", async () => {
    let capturedUrl: URL | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedUrl = new URL(String(input));
        return Response.json({ id: "wd_2" });
      }),
    );

    await startSep6Withdraw("https://anchor.example/api/v2/sep6/", "token", BASE_INPUT);

    expect(capturedUrl!.pathname).toBe("/api/v2/sep6/withdraw");
  });

  it("omits empty or undefined field parameters", async () => {
    let capturedUrl: URL | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        capturedUrl = new URL(String(input));
        return Response.json({ id: "wd_3" });
      }),
    );

    // Test with undefined
    await startSep6Withdraw("https://anchor.example/sep6", "token", {
      ...BASE_INPUT,
      fields: undefined,
    });

    expect(capturedUrl!.searchParams.has("dest")).toBe(false);
    expect(capturedUrl!.searchParams.has("dest_extra")).toBe(false);

    // Test with empty string
    await startSep6Withdraw("https://anchor.example/sep6", "token", {
      ...BASE_INPUT,
      fields: {
        dest: "",
        dest_extra: "",
      },
    });

    expect(capturedUrl!.searchParams.has("dest")).toBe(false);
    expect(capturedUrl!.searchParams.has("dest_extra")).toBe(false);
  });

  it.each([
    ["text", "text"],
    ["id", "id"],
    ["hash", "hash"],
    ["unknown", undefined],
    ["return", undefined],
    ["none", undefined],
    [undefined, undefined],
  ])("maps memo_type %s correctly to %s per allow-list", async (inputMemoType, expectedMemoType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "wd_memo",
          account_id: "GDEPOSITACCOUNT",
          memo: "memo_value",
          ...(inputMemoType !== undefined ? { memo_type: inputMemoType } : {}),
        }),
      ),
    );

    const res = await startSep6Withdraw("https://anchor.example/sep6", "jwt", BASE_INPUT);

    expect(res).toEqual({
      id: "wd_memo",
      accountId: "GDEPOSITACCOUNT",
      memo: "memo_value",
      memoType: expectedMemoType,
    });
  });

  it("throws AnchorHttpError on non-OK response with error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("amount too small for bank_account", { status: 400 })),
    );

    await expect(startSep6Withdraw("https://anchor.example/sep6", "jwt", BASE_INPUT)).rejects.toMatchObject({
      name: "AnchorHttpError",
      sep: "6",
      op: "withdraw",
      status: 400,
      body: "amount too small for bank_account",
      message: "SEP-6 withdraw failed: 400",
    });
  });

  it("handles extra anchor response fields gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "wd_extra",
          account_id: "GDEPOSITACCOUNT",
          memo: "12345",
          memo_type: "id",
          how: "send 100 USDC to GDEPOSITACCOUNT",
          eta: 300,
          amount_out: "99.00",
          message: "please transfer funds",
        }),
      ),
    );

    const res = await startSep6Withdraw("https://anchor.example/sep6", "jwt", BASE_INPUT);

    expect(res).toEqual({
      id: "wd_extra",
      accountId: "GDEPOSITACCOUNT",
      memo: "12345",
      memoType: "id",
    });
  });

  it("logs start and ok events when logger is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "wd_log",
          account_id: "GDEST",
          memo: "123",
          memo_type: "id",
        }),
      ),
    );

    const info = vi.fn();
    const warn = vi.fn();
    const logger: Logger = {
      child: () => logger,
      info,
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    };

    await startSep6Withdraw("https://anchor.example/sep6", "jwt", BASE_INPUT, logger);

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "anchor.sep6.withdraw.start", assetCode: "USDC", amount: "100.50" }),
      "starting SEP-6 withdraw",
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "anchor.sep6.withdraw.ok", withdrawId: "wd_log", accountId: "GDEST" }),
      "SEP-6 withdraw started",
    );
  });

  it("logs fail event when request fails and logger is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("internal error", { status: 500 })),
    );

    const warn = vi.fn();
    const logger: Logger = {
      child: () => logger,
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
    };

    await expect(startSep6Withdraw("https://anchor.example/sep6", "jwt", BASE_INPUT, logger)).rejects.toBeInstanceOf(
      AnchorHttpError,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "anchor.sep6.withdraw.fail", statusCode: 500 }),
      "SEP-6 withdraw failed",
    );
  });
});
