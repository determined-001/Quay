/**
 * Unit tests for the SSRF guard.
 *
 * All tests mock node:dns so no real DNS resolution happens.  A "rebinding
 * simulation" test at the bottom checks that the guard re-resolves at delivery
 * time and catches a hostname that moved from a public IP to a private one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { guardWebhookUrl } from "../src/services/ssrf-guard";

// ---------------------------------------------------------------------------
// DNS mock helpers
// ---------------------------------------------------------------------------
vi.mock("node:dns", () => ({
  promises: {
    resolve: vi.fn(),
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

import { promises as dns } from "node:dns";

const mockResolve = vi.mocked(dns.resolve);
const mockResolve4 = vi.mocked(dns.resolve4);
const mockResolve6 = vi.mocked(dns.resolve6);

function mockPublicIp(ip = "1.2.3.4"): void {
  // dns.resolve("ANY") returns mixed; we lean on the fallback path (resolve4/6)
  mockResolve.mockRejectedValue(new Error("ENODATA"));
  mockResolve4.mockResolvedValue([ip] as never);
  mockResolve6.mockResolvedValue([] as never);
}

function mockPrivateIp(ip: string): void {
  mockResolve.mockRejectedValue(new Error("ENODATA"));
  mockResolve4.mockResolvedValue([ip] as never);
  mockResolve6.mockResolvedValue([] as never);
}

function mockPrivateIpv6(ip: string): void {
  mockResolve.mockRejectedValue(new Error("ENODATA"));
  mockResolve4.mockResolvedValue([] as never);
  mockResolve6.mockResolvedValue([ip] as never);
}

function mockDnsFailure(): void {
  mockResolve.mockRejectedValue(new Error("ENOTFOUND"));
  mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
  mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: NODE_ENV is not "production" in tests
  process.env.NODE_ENV = "test";
});

// ---------------------------------------------------------------------------
// Scheme checks
// ---------------------------------------------------------------------------
describe("scheme validation", () => {
  it("allows https:// in production mode", async () => {
    mockPublicIp();
    const r = await guardWebhookUrl("https://example.com/hook", { productionMode: true });
    expect(r.ok).toBe(true);
  });

  it("rejects http:// in production mode", async () => {
    const r = await guardWebhookUrl("http://example.com/hook", { productionMode: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/https/i);
  });

  it("allows http:// outside production mode", async () => {
    mockPublicIp();
    const r = await guardWebhookUrl("http://example.com/hook", { productionMode: false });
    expect(r.ok).toBe(true);
  });

  it("rejects non-http/https schemes", async () => {
    const r = await guardWebhookUrl("ftp://example.com/hook");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unsupported scheme/i);
  });

  it("rejects malformed URLs", async () => {
    const r = await guardWebhookUrl("not a url at all");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Port checks
// ---------------------------------------------------------------------------
describe("port validation", () => {
  it("allows default port (no explicit port)", async () => {
    mockPublicIp();
    const r = await guardWebhookUrl("https://example.com/hook");
    expect(r.ok).toBe(true);
  });

  it("allows explicit :443", async () => {
    mockPublicIp();
    const r = await guardWebhookUrl("https://example.com:443/hook");
    expect(r.ok).toBe(true);
  });

  it("rejects :8080", async () => {
    const r = await guardWebhookUrl("https://example.com:8080/hook");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/non-standard port/i);
  });

  it("rejects :22 (SSH)", async () => {
    const r = await guardWebhookUrl("https://example.com:22/hook");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Private IPv4 ranges
// ---------------------------------------------------------------------------
describe("private IPv4 rejection", () => {
  const cases: [string, string][] = [
    ["loopback",           "127.0.0.1"],
    ["loopback high",      "127.255.255.254"],
    ["RFC-1918 10/8",      "10.0.0.1"],
    ["RFC-1918 10/8 high", "10.255.255.255"],
    ["RFC-1918 172.16/12", "172.16.0.1"],
    ["RFC-1918 172.31/12", "172.31.255.254"],
    ["RFC-1918 192.168/16","192.168.1.1"],
    ["link-local",         "169.254.169.254"],   // AWS/GCP metadata
    ["link-local alt",     "169.254.0.1"],
    ["CGNAT low",          "100.64.0.0"],
    ["CGNAT high",         "100.127.255.255"],
    ["CGNAT metadata",     "100.100.100.200"],
    ["IETF low",           "192.0.0.0"],
    ["IETF high",          "192.0.0.255"],
    ["benchmarking low",   "198.18.0.0"],
    ["benchmarking high",  "198.19.255.255"],
    ["TEST-NET-1 low",     "192.0.2.0"],
    ["TEST-NET-1 high",    "192.0.2.255"],
    ["TEST-NET-2 low",     "198.51.100.0"],
    ["TEST-NET-2 high",    "198.51.100.255"],
    ["TEST-NET-3 low",     "203.0.113.0"],
    ["TEST-NET-3 high",    "203.0.113.255"],
  ];

  for (const [label, ip] of cases) {
    it(`rejects ${label} (${ip})`, async () => {
      mockPrivateIp(ip);
      const r = await guardWebhookUrl("https://internal.example.com/hook");
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toMatch(/private|reserved/i);
    });
  }
});

// ---------------------------------------------------------------------------
// Private IPv6 ranges
// ---------------------------------------------------------------------------
describe("private IPv6 rejection", () => {
  it("rejects ::1 (loopback)", async () => {
    mockPrivateIpv6("::1");
    const r = await guardWebhookUrl("https://ipv6host.example.com/hook");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/private|reserved/i);
  });

  it("rejects fc00:: (ULA)", async () => {
    mockPrivateIpv6("fc00::1");
    const r = await guardWebhookUrl("https://ipv6host.example.com/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects fe80:: (link-local)", async () => {
    mockPrivateIpv6("fe80::1");
    const r = await guardWebhookUrl("https://ipv6host.example.com/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects IPv4-mapped CGNAT (::ffff:100.64.0.1)", async () => {
    mockPrivateIpv6("::ffff:100.64.0.1");
    const r = await guardWebhookUrl("https://ipv6host.example.com/hook");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/private|reserved/i);
  });
});

// ---------------------------------------------------------------------------
// DNS failure
// ---------------------------------------------------------------------------
describe("DNS failures", () => {
  it("rejects unresolvable hostname", async () => {
    mockDnsFailure();
    const r = await guardWebhookUrl("https://doesnotexist.invalid/hook");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/resolve|not found|no dns records/i);
  });
});

// ---------------------------------------------------------------------------
// Public IPs — should pass
// ---------------------------------------------------------------------------
describe("public IP pass-through", () => {
  it("allows a normal public IP", async () => {
    mockPublicIp("93.184.216.34"); // example.com
    const r = await guardWebhookUrl("https://example.com/hook");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolvedIp).toBe("93.184.216.34");
  });

  const outsideCases: [string, string][] = [
    ["outside CGNAT below", "100.63.255.255"],
    ["outside CGNAT above", "100.128.0.0"],
    ["outside IETF protocol below", "191.255.255.255"],
    ["outside IETF protocol above", "192.0.1.0"],
    ["outside benchmarking below", "198.17.255.255"],
    ["outside benchmarking above", "198.20.0.0"],
    ["outside TEST-NET-1 below", "192.0.1.255"],
    ["outside TEST-NET-1 above", "192.0.3.0"],
    ["outside TEST-NET-2 below", "198.51.99.255"],
    ["outside TEST-NET-2 above", "198.51.101.0"],
    ["outside TEST-NET-3 below", "203.0.112.255"],
    ["outside TEST-NET-3 above", "203.0.114.0"],
  ];

  for (const [label, ip] of outsideCases) {
    it(`allows ${label} (${ip})`, async () => {
      mockPublicIp(ip);
      const r = await guardWebhookUrl("https://example.com/hook");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolvedIp).toBe(ip);
    });
  }
});

// ---------------------------------------------------------------------------
// Allowlist bypass
// ---------------------------------------------------------------------------
describe("host allowlist", () => {
  it("bypasses IP check for allowlisted hostname", async () => {
    // No DNS mock needed — allowlist skips resolution.
    const r = await guardWebhookUrl("https://trusted-internal.corp/hook", {
      allowlist: ["trusted-internal.corp"],
    });
    expect(r.ok).toBe(true);
  });

  it("does not bypass for non-listed hostname", async () => {
    mockPrivateIp("10.0.0.1");
    const r = await guardWebhookUrl("https://not-trusted.corp/hook", {
      allowlist: ["trusted-internal.corp"],
    });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS rebinding simulation
// ---------------------------------------------------------------------------
describe("DNS rebinding defence", () => {
  it("detects when a hostname resolves to a private IP on second call", async () => {
    // First call (registration time): public IP → allowed.
    mockPublicIp("1.2.3.4");
    const first = await guardWebhookUrl("https://rebinding.example.com/hook");
    expect(first.ok).toBe(true);

    // Second call (delivery time): same hostname now resolves to 169.254.169.254.
    mockPrivateIp("169.254.169.254");
    const second = await guardWebhookUrl("https://rebinding.example.com/hook");
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toMatch(/private|reserved/i);
  });
});
