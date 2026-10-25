import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 90, statements: 90, functions: 85, branches: 80 }),
    include: ["test/**/*.test.ts"],
  },
});
