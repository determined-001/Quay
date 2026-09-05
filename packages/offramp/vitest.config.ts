import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 38, statements: 38, functions: 38, branches: 44 }),
    include: ["test/**/*.test.ts"],
  },
});
