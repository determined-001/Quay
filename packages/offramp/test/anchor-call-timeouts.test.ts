import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnchorTimeoutError } from "../src/http";
import { deleteSep12Customer } from "../src/sep12";
import { clearSep24InfoCache, getSep24Info } from "../src/sep24";

// A stalled anchor accepts the connection and never answers. Every SEP call in
// the cash-out path must give up with AnchorTimeoutError instead of holding the
// poller tick or the seller's request until the socket times out (issue 3.31).
function hangUntilAborted() {
  return vi.fn().mockImplementation(
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
}

describe("anchor calls abort on a stalled anchor", () => {
  // AbortSignal.timeout runs on the real clock, so hand anchorFetch a signal the
  // test fires itself instead of waiting 10 seconds.
  let fire: () => void;
  beforeEach(() => {
    clearSep24InfoCache();
    const controller = new AbortController();
    fire = () => controller.abort();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("SEP-12 customer calls", async () => {
    vi.stubGlobal("fetch", hangUntilAborted());
    const pending = deleteSep12Customer("https://anchor.example/sep12", "jwt", "GACCOUNT");
    const assertion = expect(pending).rejects.toBeInstanceOf(AnchorTimeoutError);
    await Promise.resolve();
    fire();
    await assertion;
  });

  it("SEP-24 /info", async () => {
    vi.stubGlobal("fetch", hangUntilAborted());
    const pending = getSep24Info("https://anchor.example/sep24");
    const assertion = expect(pending).rejects.toBeInstanceOf(AnchorTimeoutError);
    await Promise.resolve();
    fire();
    await assertion;
  });
});
