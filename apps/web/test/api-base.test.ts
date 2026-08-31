import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Regression for issue 5.9 / BUG-1.4 (2026-07-14).
 *
 * A Vercel build ran with NEXT_PUBLIC_API_URL unset, so the `http://localhost:8787`
 * local-dev fallback was baked into the client bundle and every visitor's browser
 * silently tried to reach localhost on their own machine. The fix that shipped at
 * the time was a deploy-checklist reminder, not code — so nothing stopped it from
 * recurring. These pin the four branches of `BROWSER_BASE`.
 *
 * `BROWSER_BASE` is resolved at module load, so each case re-imports the module
 * under a fresh environment rather than calling a function.
 */
const DEV_FALLBACK = "http://localhost:8787";

async function loadApiBase(): Promise<string> {
  vi.resetModules();
  const mod = await import("../lib/api");
  return mod.apiBase();
}

function withBrowser(present: boolean): void {
  if (present) {
    (globalThis as { window?: unknown }).window = globalThis;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
}

describe("BROWSER_BASE — a production build must not ship the localhost fallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    withBrowser(false);
    vi.resetModules();
  });

  it("uses NEXT_PUBLIC_API_URL when it is set, in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com");
    withBrowser(true);

    await expect(loadApiBase()).resolves.toBe("https://api.example.com");
  });

  it("keeps the localhost fallback outside production — local dev is unaffected", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    withBrowser(true);

    await expect(loadApiBase()).resolves.toBe(DEV_FALLBACK);
  });

  it("throws at module load in a production browser bundle with the variable unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    withBrowser(true);

    await expect(loadApiBase()).rejects.toThrow(/NEXT_PUBLIC_API_URL is not set/);
  });

  it("names the variable and says to rebuild, not just redeploy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    withBrowser(true);

    await expect(loadApiBase()).rejects.toThrow(/REBUILD/);
  });

  // The server bundle reaches the API via API_URL and never needs the
  // NEXT_PUBLIC_ one, so it must not be punished for a client-only variable.
  // Throwing here would take down prerendering during `next build`.
  it("does not throw in the production server bundle — API_URL is that path's variable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    vi.stubEnv("API_URL", "https://api.example.com");
    withBrowser(false);

    await expect(loadApiBase()).resolves.toBe("https://api.example.com");
  });
});
