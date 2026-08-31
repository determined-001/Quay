import { describe, expect, it } from "vitest";
import { activeEnvironments, buildEnvironments, buildTargets, recordResult, renderStatusMd, uptimePct } from "./uptime-check.mjs";

describe("buildEnvironments", () => {
  it("testnet always defaults to the public testnet deploy, unprefixed", () => {
    const [testnet] = buildEnvironments({});
    expect(testnet.id).toBe("testnet");
    expect(testnet.apiUrl).toBe("https://quay-api.onrender.com");
    expect(testnet.webUrl).toBe("https://quay-web.vercel.app");
    expect(testnet.syntheticLink).toBe(true);
    expect(testnet.prefixIds).toBe(false);
  });

  it("testnet honors the original UPTIME_API_URL / UPTIME_WEB_URL var names", () => {
    const [testnet] = buildEnvironments({
      UPTIME_API_URL: "https://custom-api.example",
      UPTIME_WEB_URL: "https://custom-web.example",
    });
    expect(testnet.apiUrl).toBe("https://custom-api.example");
    expect(testnet.webUrl).toBe("https://custom-web.example");
  });

  it("mainnet has no URL default of any kind — unset means unconfigured, not guessed", () => {
    const [, mainnet] = buildEnvironments({});
    expect(mainnet.id).toBe("mainnet");
    expect(mainnet.apiUrl).toBeNull();
    expect(mainnet.webUrl).toBeNull();
  });

  it("mainnet picks up its URLs once configured, and prefixes its target ids", () => {
    const [, mainnet] = buildEnvironments({
      UPTIME_MAINNET_API_URL: "https://quay-api-mainnet.onrender.com",
      UPTIME_MAINNET_WEB_URL: "https://quay-web-mainnet.example",
    });
    expect(mainnet.apiUrl).toBe("https://quay-api-mainnet.onrender.com");
    expect(mainnet.webUrl).toBe("https://quay-web-mainnet.example");
    expect(mainnet.prefixIds).toBe(true);
  });

  it("mainnet's synthetic-link check stays off unless explicitly opted into", () => {
    const [, withoutOptIn] = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    expect(withoutOptIn.syntheticLink).toBe(false);

    const [, withOptIn] = buildEnvironments({
      UPTIME_MAINNET_API_URL: "https://mainnet.example",
      UPTIME_MAINNET_SYNTHETIC_CHECK: "1",
    });
    expect(withOptIn.syntheticLink).toBe(true);
  });
});

describe("activeEnvironments", () => {
  it("drops any environment with no API URL configured", () => {
    const environments = buildEnvironments({});
    expect(activeEnvironments(environments).map((e) => e.id)).toEqual(["testnet"]);
  });

  it("includes mainnet once its API URL is set", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    expect(activeEnvironments(environments).map((e) => e.id)).toEqual(["testnet", "mainnet"]);
  });
});

describe("buildTargets", () => {
  it("testnet keeps its original, unprefixed target ids (back-compat with existing history/badges)", () => {
    const environments = buildEnvironments({});
    const ids = buildTargets(environments).map((t) => t.id);
    expect(ids).toEqual(["api", "web", "synthetic"]);
  });

  it("mainnet's target ids are prefixed and never collide with testnet's", () => {
    const environments = buildEnvironments({
      UPTIME_MAINNET_API_URL: "https://mainnet.example",
      UPTIME_MAINNET_WEB_URL: "https://mainnet-web.example",
      UPTIME_MAINNET_SYNTHETIC_CHECK: "1",
    });
    const ids = buildTargets(environments).map((t) => t.id);
    expect(ids).toEqual(["api", "web", "synthetic", "mainnet-api", "mainnet-web", "mainnet-synthetic"]);
  });

  it("omits the web target for an environment with no web URL, and the synthetic target when disabled", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const mainnetIds = buildTargets(environments)
      .filter((t) => t.env.id === "mainnet")
      .map((t) => t.id);
    expect(mainnetIds).toEqual(["mainnet-api"]);
  });

  it("labels every target with its environment, so an issue title can never be ambiguous about which one", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const targets = buildTargets(environments);
    expect(targets.find((t) => t.id === "api")?.label).toBe("Testnet — API");
    expect(targets.find((t) => t.id === "mainnet-api")?.label).toBe("Mainnet — API");
  });
});

describe("recordResult / uptimePct", () => {
  it("tracks consecutive failures per target id independently", () => {
    const state = { targets: {} };
    recordResult(state, "testnet-api", false, "boom");
    const { justFailed } = recordResult(state, "testnet-api", false, "boom");
    expect(justFailed).toBe(true);
    // A different id (e.g. mainnet's own "api") must not share this counter.
    expect(state.targets["mainnet-api"]).toBeUndefined();
  });

  it("uptimePct is 100 with no data, and reflects a mixed today", () => {
    expect(uptimePct([], null)).toBe(100);
    expect(uptimePct([], { up: 3, down: 1 })).toBe(75);
  });
});

describe("renderStatusMd", () => {
  it("only reports environments that have actually been checked", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const state = { targets: {} };
    recordResult(state, "api", true, null);

    const md = renderStatusMd(state, environments);
    expect(md).toContain("## Testnet");
    expect(md).not.toContain("## Mainnet");
  });

  it("gives each environment its own section, with per-kind subsections underneath", () => {
    const environments = buildEnvironments({ UPTIME_MAINNET_API_URL: "https://mainnet.example" });
    const state = { targets: {} };
    recordResult(state, "api", true, null);
    recordResult(state, "mainnet-api", false, "connection refused");

    const md = renderStatusMd(state, environments);
    const testnetIdx = md.indexOf("## Testnet");
    const mainnetIdx = md.indexOf("## Mainnet");
    expect(testnetIdx).toBeGreaterThanOrEqual(0);
    expect(mainnetIdx).toBeGreaterThan(testnetIdx);
    expect(md.indexOf("### API", testnetIdx)).toBeLessThan(mainnetIdx);
    expect(md).toContain("🔴 down");
    expect(md).toContain("connection refused");
  });
});
