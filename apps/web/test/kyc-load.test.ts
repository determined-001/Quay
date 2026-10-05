import { describe, expect, it } from "vitest";
import { kycPanelStage } from "../lib/kyc-load";

describe("kycPanelStage", () => {
  it("shows the connect prompt when the anchor session is missing, even after an error", () => {
    expect(kycPanelStage({ anchorNeedsConnect: true, state: "error", hasKyc: false })).toBe("connect");
    expect(kycPanelStage({ anchorNeedsConnect: true, state: "loading", hasKyc: false })).toBe("connect");
  });
  it("shows loading only while the request is in flight or not yet started", () => {
    expect(kycPanelStage({ anchorNeedsConnect: false, state: "loading", hasKyc: false })).toBe("loading");
    expect(kycPanelStage({ anchorNeedsConnect: false, state: "idle", hasKyc: false })).toBe("loading");
  });
  it("shows the error instead of loading forever when the fetch failed", () => {
    expect(kycPanelStage({ anchorNeedsConnect: false, state: "error", hasKyc: false })).toBe("error");
  });
  it("keeps showing an existing record when a refresh fails", () => {
    expect(kycPanelStage({ anchorNeedsConnect: false, state: "error", hasKyc: true })).toBe("content");
  });
  it("shows content once the KYC record is available", () => {
    expect(kycPanelStage({ anchorNeedsConnect: false, state: "ready", hasKyc: true })).toBe("content");
  });
});
