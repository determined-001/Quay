import { describe, expect, it } from "vitest";
import { loggablePath } from "../src/request-context";

describe("loggablePath", () => {
  it("masks the secret SEP-12 callback token", () => {
    expect(loggablePath("/anchor-callbacks/sep12/anchor.example/abc123secret")).toBe(
      "/anchor-callbacks/sep12/anchor.example/[redacted]",
    );
  });
  it("leaves other paths alone", () => {
    expect(loggablePath("/seller/kyc")).toBe("/seller/kyc");
  });
});
