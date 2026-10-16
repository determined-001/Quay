import { defineConfig } from "vitest/config";

// Scoped to scripts/ only - each workspace package (apps/*, packages/*) runs
// its own vitest instance via its own "test" script through turbo; this root
// config exists solely for scripts/, which isn't a workspace package.
export default defineConfig({
  plugins: [
    {
      name: "strip-shebang",
      transform(code) {
        if (code.startsWith("#!")) {
          return { code: code.replace(/^#![^\n]*/, "") };
        }
      },
    },
  ],
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
