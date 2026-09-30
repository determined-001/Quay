import { describe, expect, it } from "vitest";
import { AnchorAuthRequiredError } from "../src/ports/index";

describe("AnchorAuthRequiredError", () => {
  it("names the anchor the seller has to sign in to, and is catchable by type", () => {
    const err = new AnchorAuthRequiredError("anchor.example");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AnchorAuthRequiredError);
    expect(err.name).toBe("AnchorAuthRequiredError");
    expect(err.anchorDomain).toBe("anchor.example");
    expect(err.message).toMatch(/anchor\.example/);
  });
});
