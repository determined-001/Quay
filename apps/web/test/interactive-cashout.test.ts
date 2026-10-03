import { describe, expect, it } from "vitest";
import {
  anchorLabelForUrl,
  describeInteractiveStatus,
  interactivePollDelayMs,
  INTERACTIVE_POLL_MS,
  INTERACTIVE_POLL_SLOW_MS,
  isInteractiveTerminalStatus,
  parseInteractiveUrl,
} from "../lib/interactive-cashout";

describe("parseInteractiveUrl", () => {
  it("accepts https URLs", () => {
    expect(parseInteractiveUrl("https://anchor.example.com/tx/123")).toEqual({
      ok: true,
      href: "https://anchor.example.com/tx/123",
    });
  });

  it("refuses non-https URLs", () => {
    expect(parseInteractiveUrl("http://anchor.example.com/tx/123").ok).toBe(
      false,
    );
    expect(parseInteractiveUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("refuses unparseable input", () => {
    expect(parseInteractiveUrl("not a url").ok).toBe(false);
  });
});

describe("anchorLabelForUrl", () => {
  it("returns the hostname", () => {
    expect(anchorLabelForUrl("https://testanchor.stellar.org/sep24/tx/1")).toBe(
      "testanchor.stellar.org",
    );
  });

  it("falls back for unparseable input", () => {
    expect(anchorLabelForUrl("not a url")).toBe("the anchor");
  });
});

describe("describeInteractiveStatus", () => {
  it("maps incomplete to the waiting-on-you message", () => {
    expect(describeInteractiveStatus("incomplete")).toBe(
      "Waiting for you to finish in the anchor's window.",
    );
  });

  it("names the anchor-side waits in plain words", () => {
    expect(describeInteractiveStatus("pending_anchor")).toContain("Anchor");
    expect(describeInteractiveStatus("pending_external")).toContain("external");
  });

  it("handles missing and unknown statuses", () => {
    expect(describeInteractiveStatus(null)).toContain("Waiting");
    expect(describeInteractiveStatus(undefined)).toContain("Waiting");
    expect(describeInteractiveStatus("weird_status")).toContain("weird_status");
  });
});

describe("interactivePollDelayMs", () => {
  it("polls every 5 s, backing off to 30 s after 2 minutes", () => {
    expect(interactivePollDelayMs(0)).toBe(INTERACTIVE_POLL_MS);
    expect(interactivePollDelayMs(119_999)).toBe(INTERACTIVE_POLL_MS);
    expect(interactivePollDelayMs(120_000)).toBe(INTERACTIVE_POLL_SLOW_MS);
    expect(interactivePollDelayMs(10 * 60_000)).toBe(INTERACTIVE_POLL_SLOW_MS);
  });
});

describe("isInteractiveTerminalStatus", () => {
  it("closes only on settled or failed", () => {
    expect(isInteractiveTerminalStatus("settled")).toBe(true);
    expect(isInteractiveTerminalStatus("failed")).toBe(true);
    expect(isInteractiveTerminalStatus("pending")).toBe(false);
    expect(isInteractiveTerminalStatus(null)).toBe(false);
    expect(isInteractiveTerminalStatus(undefined)).toBe(false);
  });
});
