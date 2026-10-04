import { describe, expect, it } from "vitest";
import { ProfileFieldRejectedError } from "../src";

describe("ProfileFieldRejectedError", () => {
  it("names the field and reason for an unknown field", () => {
    const err = new ProfileFieldRejectedError("favourite_colour", "unknown_field");
    expect(err.field).toBe("favourite_colour");
    expect(err.reason).toBe("unknown_field");
    expect(err.message).toBe('"favourite_colour" is not a SEP-9 field');
    expect(err.name).toBe("ProfileFieldRejectedError");
  });

  it("explains that binary data is never persisted", () => {
    const err = new ProfileFieldRejectedError("photo_id_front", "binary_field");
    expect(err.message).toContain("binary data is never persisted");
  });
});
