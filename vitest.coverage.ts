import type { ViteUserConfig } from "vitest/config";

type Metrics = { lines: number; statements: number; functions: number; branches: number };

/**
 * Shared coverage settings for every workspace package (issue #49).
 *
 * Thresholds are a **ratchet**: each one was set to the package's measured
 * coverage at the time gating was introduced, floored to a whole percent. They
 * exist to stop coverage sliding, not to assert the numbers are good — several
 * are well short of where they should be, and the issue's targets (core 90,
 * stellar/offramp/api 70) are the direction to raise them in, not the floor
 * today.
 *
 * Raise a threshold when you raise the coverage. Never lower one to make a
 * build pass: that is the one move this whole mechanism exists to prevent.
 */
export function coverage(thresholds: Metrics): NonNullable<NonNullable<ViteUserConfig["test"]>["coverage"]> {
  return {
    provider: "v8",
    // Only our own source. Without this, v8 reports on whatever happened to be
    // loaded, and the number moves when an unrelated dependency changes.
    include: ["src/**"],
    exclude: [
      "**/*.d.ts",
      // Type-only modules compile to nothing, so they cannot be "covered" —
      // counting them just dilutes the number in whichever direction.
      "**/types.ts",
      "**/*.types.ts",
    ],
    reporter: ["text", "json-summary", "html"],
    // Deliberately off: autoUpdate would silently rewrite a threshold downward
    // on the branch that dropped coverage, which is exactly the failure this
    // gate is meant to catch.
    thresholds: { ...thresholds, autoUpdate: false },
  };
}
