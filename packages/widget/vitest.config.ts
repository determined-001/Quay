import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 95, statements: 95, functions: 95, branches: 80 }),
    include: ["test/**/*.test.ts"],
  },
});
