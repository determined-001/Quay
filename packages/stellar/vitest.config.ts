import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 79, statements: 78, functions: 85, branches: 69 }),
    include: ["test/**/*.test.ts"],
  },
});
