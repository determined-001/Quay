import { describe, expect, it, vi } from "vitest";
import type { AnchorCustomer, KycFieldSpec, KycRecord, ProvidedFieldStatus } from "@checkout/core";
import { TestAnchorKyc } from "../src/kyc";
import { selectFieldsForAnchor } from "@checkout/core";
import * as sep12 from "../src/sep12";

describe("TestAnchorKyc.selectFieldsForAnchor", () => {
  const requested: KycFieldSpec[] = [
    { name: "first_name", type: "string", optional: false },
    { name: "last_name", type: "string", optional: false },
    { name: "email_address", type: "string", optional: true },
    { name: "custom_field", type: "string", optional: false },
  ];

  it("selects only requested fields from profile", () => {
    const result = selectFieldsForAnchor({
      requested,
      profile: {
        fields: {
          first_name: "Ada",
          last_name: "Lovelace",
          email_address: "ada@example.org",
          mobile_number: "+15551234567",
        },
      },
      overrides: {},
    });

    expect(result.send).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.org",
    });
    expect(result.missing).toEqual(["custom_field"]);
    expect(result.unknown).toEqual(["custom_field"]);
  });

  it("maps family_name alias to last_name from profile", () => {
    const result = selectFieldsForAnchor({
      requested: [{ name: "family_name", type: "string", optional: false }],
      profile: { fields: { last_name: "Lovelace" } },
      overrides: {},
    });

    expect(result.send).toEqual({ family_name: "Lovelace" });
  });
});

describe("TestAnchorKyc.submit field mapping", () => {
  const mockAnchorCustomer: AnchorCustomer = {
    sellerId: "sel_1",
    account: "GSELLER",
  };

  const mockProfile = {
    fields: {
      first_name: "Ada",
      last_name: "Lovelace",
      email_address: "ada@example.org",
      mobile_number: "+15551234567",
    },
  };

  const mockDiscovery = {
    requiredFields: [
      { name: "first_name", type: "string", optional: false },
      { name: "last_name", type: "string", optional: false },
      { name: "email_address", type: "string", optional: true },
      { name: "custom_field", type: "string", optional: false },
    ] as KycFieldSpec[],
    customerId: "cus_1",
    status: "NEEDS_INFO" as const,
    message: null,
  };

  const mockRemote = {
    ...mockDiscovery,
    customerId: "cus_1",
    status: "NEEDS_INFO" as const,
    message: null,
  };

  const mockAfter = {
    ...mockDiscovery,
    customerId: "cus_1",
    status: "ACCEPTED" as const,
    providedFieldStatus: [
      { name: "first_name", status: "ACCEPTED", error: null },
      { name: "last_name", status: "ACCEPTED", error: null },
      { name: "email_address", status: "ACCEPTED", error: null },
    ] as ProvidedFieldStatus[],
    message: null,
  };

  it("uses selectFieldsForAnchor to determine send body", async () => {
    const profileRepo = {
      get: vi.fn().mockResolvedValue(mockProfile),
    };

    const kyc = new TestAnchorKyc({
      discovery: {
        get: vi.fn().mockResolvedValue({ kycServer: "https://test.example" }),
      },
      auth: {
        token: vi.fn().mockResolvedValue("jwt"),
      } as any,
      repo: {
        get: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
      },
      profileRepo,
    });

    const putSep12CustomerSpy = vi.spyOn(sep12, "putSep12Customer");
    const getSep12CustomerSpy = vi.spyOn(sep12, "getSep12Customer");

    getSep12CustomerSpy
      .mockResolvedValueOnce(mockDiscovery)  // discovery
      .mockResolvedValueOnce(mockAfter);     // after

    putSep12CustomerSpy.mockResolvedValue({ customerId: "cus_1" });

    const result = await kyc.submit(mockAnchorCustomer, { custom_field: "override_value" });

    // Verify selectFieldsForAnchor was called by checking what was sent to putSep12Customer
    expect(putSep12CustomerSpy).toHaveBeenCalledWith(
      "https://test.example",
      "jwt",
      expect.objectContaining({
        fields: expect.objectContaining({
          first_name: "Ada",
          last_name: "Lovelace",
          email_address: "ada@example.org",
          custom_field: "override_value",
        }),
      })
    );

    // Verify sentFields recorded correctly
    expect(result.sentFields).toEqual(["first_name", "last_name", "email_address", "custom_field"]);
  });

  it("throws KycRequiredError when required field is missing", async () => {
    const kyc = new TestAnchorKyc({
      discovery: {
        get: vi.fn().mockResolvedValue({ kycServer: "https://test.example" }),
      },
      auth: {
        token: vi.fn().mockResolvedValue("jwt"),
      } as any,
      repo: {
        get: vi.fn().mockResolvedValue(null),
        save: vi.fn().mockResolvedValue(undefined),
      },
      profileRepo: {
        get: vi.fn().mockResolvedValue({ fields: {} }),
      },
    });

    const getSep12CustomerSpy = vi.spyOn(sep12, "getSep12Customer");
    getSep12CustomerSpy.mockResolvedValue({
      requiredFields: [{ name: "required_field", type: "string", optional: false }] as any,
      customerId: null,
      status: "NEEDS_INFO",
      message: null,
    });

    await expect(kyc.submit(mockAnchorCustomer, {})).rejects.toThrow("Missing required KYC fields");
  });
});
describe("TestAnchorKyc customer ids are scoped to the anchor (issue 4.24)", () => {
  const customer: AnchorCustomer = { sellerId: "sel_1", account: "GSELLER" };

  function memoryRepo() {
    const rows = new Map<string, KycRecord>();
    const key = (s: string, a: string) => `${s}|${a}`;
    return {
      rows,
      get: async (s: string, a: string) => rows.get(key(s, a)) ?? null,
      save: async (r: KycRecord) => void rows.set(key(r.sellerId, r.anchorDomain), r),
      delete: async () => {},
    };
  }

  function kycFor(repo: ReturnType<typeof memoryRepo>, anchorDomain: string) {
    return new TestAnchorKyc({
      discovery: { get: vi.fn().mockResolvedValue({ kycServer: "https://kyc.example" }) } as any,
      auth: { token: vi.fn().mockResolvedValue("jwt"), anchorDomain } as any,
      repo,
      profileRepo: { get: vi.fn().mockResolvedValue(null) },
    });
  }

  function remote(customerId: string, status: "ACCEPTED" | "NEEDS_INFO") {
    return { customerId, status, requiredFields: [], providedFieldStatus: [], message: null };
  }

  it("keeps independent status and customer id per anchor for one seller", async () => {
    const repo = memoryRepo();
    const get = vi.spyOn(sep12, "getSep12Customer");

    get.mockResolvedValueOnce(remote("cust_a", "ACCEPTED"));
    await kycFor(repo, "a.example").status(customer);

    get.mockResolvedValueOnce(remote("cust_b", "NEEDS_INFO"));
    await kycFor(repo, "b.example").status(customer);

    expect(repo.rows.size).toBe(2);
    expect(repo.rows.get("sel_1|a.example")).toMatchObject({ customerId: "cust_a", status: "ACCEPTED" });
    expect(repo.rows.get("sel_1|b.example")).toMatchObject({ customerId: "cust_b", status: "NEEDS_INFO" });
  });

  it("never sends one anchor's customer id to another", async () => {
    const repo = memoryRepo();
    const get = vi.spyOn(sep12, "getSep12Customer");
    get.mockReset();

    get.mockResolvedValueOnce(remote("cust_a", "ACCEPTED"));
    await kycFor(repo, "a.example").status(customer);

    get.mockResolvedValueOnce(remote("cust_b", "NEEDS_INFO"));
    await kycFor(repo, "b.example").status(customer);
    expect(get.mock.calls[1]![2]).toEqual({ account: "GSELLER", customerId: null });

    // The same anchor on the next sync does reuse its own id.
    get.mockResolvedValueOnce(remote("cust_a", "ACCEPTED"));
    await kycFor(repo, "a.example").status(customer);
    expect(get.mock.calls[2]![2]).toEqual({ account: "GSELLER", customerId: "cust_a" });
  });

  it("does not use a legacy row to resolve a customer id", async () => {
    const repo = memoryRepo();
    repo.rows.set("sel_1|legacy", {
      sellerId: "sel_1",
      anchorDomain: "legacy",
      account: "GSELLER",
      customerId: "cust_old",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      providedFieldStatus: [],
      sentFields: [],
      message: null,
      lastSyncedAt: null,
      updatedAt: 1,
    });
    const get = vi.spyOn(sep12, "getSep12Customer");
    get.mockReset();
    get.mockResolvedValueOnce(remote("cust_new", "NEEDS_INFO"));

    const record = await kycFor(repo, "a.example").status(customer);

    expect(get.mock.calls[0]![2]).toEqual({ account: "GSELLER", customerId: null });
    expect(record.status).toBe("NEEDS_INFO");
  });
});
