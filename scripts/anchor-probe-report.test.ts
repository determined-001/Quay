import { describe, expect, it } from "vitest";
import { flowOf, parseFailures, renderWhatBroke } from "./anchor-probe-report.mjs";

// Shaped like vitest's verbose reporter: the live tests, then the repeated FAIL summary.
const OUTPUT = `
 ✓ test/live-probe.test.ts > isHttpsOnAnchor > ok 1ms
 × test/testanchor.test.ts > TestAnchorOffRamp (live) > SEP-6: initiate() then status() completes the request/response round trip 801ms
 × test/anchor.test.ts > AnchorOffRamp SEP-24 (live) > SEP-24: initiate() returns an interactive https URL on the anchor, and status() is pending/incomplete 350ms
 × test/testanchor-full-cashout.test.ts > TestAnchorOffRamp full seller-signed cash-out (live) > stage 6/7 transfer: the seller's key pays the anchor on Horizon testnet with the exact memo 90000ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/testanchor.test.ts > TestAnchorOffRamp (live) > SEP-6: initiate() then status() completes the request/response round trip
Error: boom
 FAIL  test/anchor.test.ts > AnchorOffRamp SEP-24 (live) > SEP-24: initiate() returns an interactive https URL on the anchor, and status() is pending/incomplete
Error: boom
 FAIL  test/testanchor-full-cashout.test.ts > TestAnchorOffRamp full seller-signed cash-out (live) > stage 6/7 transfer: the seller's key pays the anchor on Horizon testnet with the exact memo
Error: boom
 FAIL  test/testanchor.test.ts > TestAnchorOffRamp (live) > SEP-6: initiate() then status() completes the request/response round trip
`;

describe("parseFailures", () => {
  it("returns each failing test once, from the FAIL lines", () => {
    const failures = parseFailures(OUTPUT);
    expect(failures.map((f) => f.file)).toEqual(["test/testanchor.test.ts", "test/anchor.test.ts", "test/testanchor-full-cashout.test.ts"]);
    expect(failures[0]?.path).toEqual([
      "TestAnchorOffRamp (live)",
      "SEP-6: initiate() then status() completes the request/response round trip",
    ]);
  });

  it("strips colour codes", () => {
    const colored = " \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m  test/anchor.test.ts > A > b";
    // The ANSI-wrapped word still has to read as FAIL once stripped.
    expect(parseFailures(colored.replace(/\u001b\[[0-9;]*m/g, ""))).toHaveLength(1);
    expect(parseFailures(colored)).toHaveLength(1);
  });

  it("finds nothing in a green run", () => {
    expect(parseFailures(" ✓ test/a.test.ts > x > y 1ms\n Test Files  1 passed")).toEqual([]);
  });
});

describe("flowOf", () => {
  const [sep6, sep24, full] = parseFailures(OUTPUT);

  it("names the SEP-6 suite", () => expect(flowOf(sep6!).id).toBe("sep6"));
  it("names the SEP-24 suite, not SEP-6", () => expect(flowOf(sep24!).id).toBe("sep24"));
  it("names the full cash-out and the stage that failed", () => {
    expect(flowOf(full!)).toEqual({ id: "full-cashout", label: 'Full seller-signed cash-out, stage "transfer"' });
  });
});

describe("renderWhatBroke", () => {
  it("lists the failing flows and tests", () => {
    const text = renderWhatBroke(parseFailures(OUTPUT));
    expect(text).toContain("SEP-24 interactive withdrawal (AnchorOffRamp)");
    expect(text).toContain('stage "transfer"');
    expect(text).toContain("SEP-1 → SEP-10 → SEP-38 → SEP-6 (TestAnchorOffRamp)");
    expect(text).toContain("`test/anchor.test.ts` › AnchorOffRamp SEP-24 (live)");
  });

  it("says so when the job failed without a failing test", () => {
    expect(renderWhatBroke([])).toMatch(/no individual failing test/);
  });
});
