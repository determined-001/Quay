import { describe, it, expect } from "vitest";
import { endpointUrl } from "../src/sep24";

// Regression cover for the nightly anchor probe's SEP-24 failure (issue #117):
// every SEP-24 call went to the anchor's origin instead of its transfer server,
// because `new URL("/transaction", base)` treats a leading slash as absolute and
// throws the base's own path away.
describe("endpointUrl", () => {
  it("keeps the transfer server's path prefix", () => {
    expect(endpointUrl("https://testanchor.stellar.org/sep24", "transactions/withdraw/interactive").toString()).toBe(
      "https://testanchor.stellar.org/sep24/transactions/withdraw/interactive",
    );
    expect(endpointUrl("https://testanchor.stellar.org/sep24", "transaction").toString()).toBe(
      "https://testanchor.stellar.org/sep24/transaction",
    );
  });

  it("is what `new URL(path, base)` gets wrong", () => {
    // The old construction — kept here so the bug cannot quietly come back.
    expect(new URL("/transaction", "https://testanchor.stellar.org/sep24").toString()).toBe(
      "https://testanchor.stellar.org/transaction",
    );
    expect(endpointUrl("https://testanchor.stellar.org/sep24", "transaction").toString()).not.toBe(
      new URL("/transaction", "https://testanchor.stellar.org/sep24").toString(),
    );
  });

  it("tolerates a trailing slash on the base and a leading slash on the path", () => {
    const expected = "https://anchor.example/sep24/transaction";
    expect(endpointUrl("https://anchor.example/sep24/", "transaction").toString()).toBe(expected);
    expect(endpointUrl("https://anchor.example/sep24", "/transaction").toString()).toBe(expected);
    expect(endpointUrl("https://anchor.example/sep24/", "/transaction").toString()).toBe(expected);
  });

  it("still works when the transfer server is the bare origin", () => {
    expect(endpointUrl("https://anchor.example", "transaction").toString()).toBe("https://anchor.example/transaction");
  });

  it("preserves a nested path prefix", () => {
    expect(endpointUrl("https://anchor.example/api/v2/sep24", "transaction").toString()).toBe(
      "https://anchor.example/api/v2/sep24/transaction",
    );
  });
});
