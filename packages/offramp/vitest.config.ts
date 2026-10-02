import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 52, statements: 51, functions: 45, branches: 51 }),
    include: ["test/**/*.test.ts"],
  },
});
