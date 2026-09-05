import { defineConfig } from "vitest/config";
import { coverage } from "../../vitest.coverage";
export default defineConfig({
  test: {
    coverage: coverage({ lines: 85, statements: 81, functions: 83, branches: 47 }),
    include: ["test/**/*.test.ts"],
  },
});
