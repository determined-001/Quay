import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 29, statements: 28, functions: 55, branches: 23 }),
    include: ["test/**/*.test.ts"],
  },
});
