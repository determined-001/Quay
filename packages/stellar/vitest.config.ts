import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

// Coverage gating (issue 8.1). Thresholds live in ../../coverage-thresholds.json,
// the single source of truth CI's ratchet check also reads - see
// scripts/check-coverage-ratchet.mjs and CONTRIBUTING.md's "Coverage" section.
const here = dirname(fileURLToPath(import.meta.url));
const thresholds = JSON.parse(readFileSync(join(here, "../../coverage-thresholds.json"), "utf8"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
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
        "src/index.ts", // pure re-export barrel - nothing to execute
      ],
      thresholds: thresholds["packages/stellar"],
    },
  },
});
