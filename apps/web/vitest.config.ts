import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "test/**/*.test.tsx"] },
  // Next.js requires "jsx": "preserve" in tsconfig.json. Vite 8 transforms
  // with oxc (not esbuild), so override the runtime here for tests only;
  // the Next build is untouched.
  oxc: { jsx: { runtime: "automatic" } },
});
