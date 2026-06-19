import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, isTerminal } from "../src/domain/status";

describe("status transitions", () => {
  it("allows the happy path active -> paid -> offramp_pending -> offramp_settled", () => {
    expect(canTransition("active", "paid")).toBe(true);
    expect(canTransition("paid", "offramp_pending")).toBe(true);
    expect(canTransition("offramp_pending", "offramp_settled")).toBe(true);
  });

  it("allows off-ramp retry after failure", () => {
    expect(canTransition("offramp_pending", "offramp_failed")).toBe(true);
    expect(canTransition("offramp_failed", "offramp_pending")).toBe(true);
  });

  it("forbids skipping payment", () => {
    expect(canTransition("active", "offramp_pending")).toBe(false);
    expect(() => assertTransition("active", "offramp_settled")).toThrow();
  });

  it("forbids leaving terminal states", () => {
    expect(canTransition("offramp_settled", "paid")).toBe(false);
    expect(canTransition("cancelled", "active")).toBe(false);
    expect(canTransition("expired", "paid")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminal("offramp_settled")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("active")).toBe(false);
    expect(isTerminal("paid")).toBe(false);
  });
});
