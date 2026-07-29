import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

// Coverage gating (issue 8.1). Thresholds live in ../../coverage-thresholds.json,
// the single source of truth CI's ratchet check also reads - see
// scripts/check-coverage-ratchet.mjs and CONTRIBUTING.md's "Coverage" section.
//
// apps/api has no enforced threshold yet - the issue this shipped in
// explicitly gates it on issue 4.10 (an integration test suite for the API)
// landing first. Coverage is still collected and reported (visible in the CI
// artifact and PR comment) so the starting point is measured honestly, just
// not gated. `coverage-thresholds.json`'s "apps/api" entry is `null` until
// 4.10 lands and a real number can be set there.
const here = dirname(fileURLToPath(import.meta.url));
const thresholds = JSON.parse(readFileSync(join(here, "../../coverage-thresholds.json"), "utf8"));

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.d.ts",
        "**/*.config.ts",
        "test/**",
        "**/*.test.ts",
        "src/db/schema.ts", // Drizzle table definitions - declarative, not logic
      ],
      thresholds: thresholds["apps/api"] ?? undefined,
    },
  },
});
