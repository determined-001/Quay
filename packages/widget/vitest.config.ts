import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
import { sharedTest } from "../../vitest.shared";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 95, statements: 95, functions: 95, branches: 80 }),
    include: ["test/**/*.test.ts"],
    ...sharedTest,
  },
});
