import { describe, expect, it } from "vitest";
import { InvalidCursorError } from "../src/ports/index";

describe("InvalidCursorError", () => {
  it("defaults to a generic message", () => {
    const err = new InvalidCursorError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InvalidCursorError");
    expect(err.message).toBe("Invalid cursor");
  });

  it("keeps a caller-supplied message", () => {
    expect(new InvalidCursorError("bad page token").message).toBe("bad page token");
  });
});
