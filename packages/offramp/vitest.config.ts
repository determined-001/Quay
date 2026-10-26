import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
import { sharedTest } from "../../vitest.shared";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 52, statements: 51, functions: 45, branches: 51 }),
    include: ["test/**/*.test.ts"],
    ...sharedTest,
  },
});
