import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
//  Where the service thinks it lives (BUG-4.18).
//
//  `HOME_DOMAIN` unset produced `WEB_AUTH_ENDPOINT="https://localhost:8787/auth"`
//  in the stellar.toml of a live deploy. Every health check was green — the API
//  answered, the watcher ran, attestation worked — while wallet-native SEP-10
//  login was impossible for anyone, because every wallet reading the TOML was
//  pointed at their own machine.
//
//  The hosting platform already knows the hostname. Requiring an operator to
//  retype it is a step that can be forgotten, and forgetting it fails silently.
// ---------------------------------------------------------------------------

const SAVED = { ...process.env };

async function loadEnv() {
  // env.ts resolves at module load, so each case needs a fresh module registry.
  vi.resetModules();
  const mod = await import("../src/env");
  return mod.env as { homeDomain: string; webAuthDomain: string };
}

beforeEach(() => {
  delete process.env.HOME_DOMAIN;
  delete process.env.WEB_AUTH_DOMAIN;
  delete process.env.RENDER_EXTERNAL_HOSTNAME;
  process.env.API_PORT = "8787";
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("home domain resolution", () => {
  it("uses the platform hostname when HOME_DOMAIN is not set", async () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = "quay-api.onrender.com";
    const env = await loadEnv();

    expect(env.homeDomain).toBe("quay-api.onrender.com");
    expect(env.webAuthDomain).toBe("quay-api.onrender.com");
    // The bug, stated directly: this must never be what a deployed service
    // publishes to wallets.
    expect(env.homeDomain).not.toContain("localhost");
  });

  it("lets HOME_DOMAIN win over the platform hostname", async () => {
    // A custom domain or proxy in front: the host the platform knows and the
    // host wallets fetch the TOML from genuinely differ, and only the operator
    // can say which is which.
    process.env.RENDER_EXTERNAL_HOSTNAME = "quay-api.onrender.com";
    process.env.HOME_DOMAIN = "api.quay.example";
    const env = await loadEnv();

    expect(env.homeDomain).toBe("api.quay.example");
  });

  it("still falls back to localhost when nothing is configured", async () => {
    const env = await loadEnv();
    expect(env.homeDomain).toBe("localhost:8787");
  });

  it("keeps WEB_AUTH_DOMAIN independent of the home domain", async () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = "quay-api.onrender.com";
    process.env.WEB_AUTH_DOMAIN = "auth.quay.example";
    const env = await loadEnv();

    expect(env.homeDomain).toBe("quay-api.onrender.com");
    expect(env.webAuthDomain).toBe("auth.quay.example");
  });

  it("ignores a blank HOME_DOMAIN rather than publishing an empty domain", async () => {
    // An env var set to "" is a common dashboard slip and reads as "configured"
    // to a truthiness check on some shapes; it must not win.
    process.env.HOME_DOMAIN = "   ";
    process.env.RENDER_EXTERNAL_HOSTNAME = "quay-api.onrender.com";
    const env = await loadEnv();

    expect(env.homeDomain).toBe("quay-api.onrender.com");
  });
});
