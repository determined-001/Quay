import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
import { sharedTest } from "../../vitest.shared";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 79, statements: 79, functions: 70, branches: 96 }),
    include: ["test/**/*.test.ts"],
    ...sharedTest,
  },
});
