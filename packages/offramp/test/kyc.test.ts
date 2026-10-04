import { describe, expect, it, vi } from "vitest";
import type { AnchorCustomer, KycFieldSpec, KycRecord, ProvidedFieldStatus } from "@checkout/core";
import { TestAnchorKyc, missingRequiredFields } from "../src/kyc";
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

describe("missingRequiredFields", () => {
  const NAME: KycFieldSpec = { name: "first_name", type: "string", optional: false };
  const PHOTO_FRONT: KycFieldSpec = { name: "photo_id_front", type: "binary", optional: false };

  it("names exactly the missing required text fields", () => {
    expect(missingRequiredFields([NAME], {})).toEqual(["first_name"]);
    expect(missingRequiredFields([NAME], { first_name: "Ada" })).toEqual([]);
  });

  it("ignores binary fields for text submissions (they go through file upload)", () => {
    expect(missingRequiredFields([NAME, PHOTO_FRONT], { first_name: "Ada" })).toEqual([]);
  });
});

describe("TestAnchorKyc.submitFiles", () => {
  const customer: AnchorCustomer = { sellerId: "sel_1", account: "GSELLER" };
  const PHOTO_FRONT: KycFieldSpec = { name: "photo_id_front", type: "binary", optional: false };
  const NAME: KycFieldSpec = { name: "first_name", type: "string", optional: false };

  it("uploads only the files, never persists binary fields, and records sentFields", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const kyc = new TestAnchorKyc({
      discovery: { get: vi.fn().mockResolvedValue({ kycServer: "https://test.example" }) },
      auth: { token: vi.fn().mockResolvedValue("jwt"), anchorDomain: "anchor.example" } as any,
      repo: {
        get: vi.fn().mockResolvedValue({
          sellerId: "sel_1",
          anchorDomain: "anchor.example",
          account: "GSELLER",
          customerId: "cus_1",
          status: "NEEDS_INFO",
          requiredFields: [NAME, PHOTO_FRONT],
          providedFields: { first_name: "Ada", photo_id_front: "should-not-survive" },
          sentFields: ["first_name"],
          message: null,
          lastSyncedAt: 0,
          updatedAt: 0,
        }),
        save,
      },
      profileRepo: { get: vi.fn().mockResolvedValue(null) },
    });

    const getSpy = vi.spyOn(sep12, "getSep12Customer");
    getSpy
      .mockResolvedValueOnce({
        requiredFields: [NAME, PHOTO_FRONT],
        customerId: "cus_1",
        status: "NEEDS_INFO",
        message: null,
      } as any)
      .mockResolvedValueOnce({
        requiredFields: [NAME, PHOTO_FRONT],
        customerId: "cus_1",
        status: "PROCESSING",
        message: null,
      } as any);
    const putSpy = vi.spyOn(sep12, "putSep12CustomerMultipart").mockResolvedValue({ customerId: "cus_1" });

    const file = { name: "photo_id_front", blob: new Blob(["x"], { type: "image/png" }), filename: "front.png" };
    const record = await kyc.submitFiles(customer, [file]);

    const params = putSpy.mock.calls[0]![2];
    expect(params.files).toEqual([file]);
    expect(params.fields).toBeUndefined();
    expect(record.providedFields).toEqual({ first_name: "Ada" });
    expect(record.sentFields).toEqual(["first_name", "photo_id_front"]);
    expect(save).toHaveBeenCalledOnce();
  });

  it("leaves no trace of the uploaded bytes or filename in the saved record or in any log output", async () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const save = vi.fn().mockResolvedValue(undefined);
    const kyc = new TestAnchorKyc({
      discovery: { get: vi.fn().mockResolvedValue({ kycServer: "https://test.example" }) },
      auth: { token: vi.fn().mockResolvedValue("jwt"), anchorDomain: "anchor.example" } as any,
      repo: { get: vi.fn().mockResolvedValue(null), save },
      profileRepo: { get: vi.fn().mockResolvedValue(null) },
    });
    vi.spyOn(sep12, "getSep12Customer").mockResolvedValue({
      requiredFields: [NAME, PHOTO_FRONT],
      customerId: "cus_1",
      status: "PROCESSING",
      providedFieldStatus: [],
      message: null,
    } as any);
    vi.spyOn(sep12, "putSep12CustomerMultipart").mockResolvedValue({ customerId: "cus_1" });

    const secretBytes = "UNIQUE-ID-PHOTO-BYTES-7f3a";
    const secretName = "passport-scan-7f3a.jpg";
    const record = await kyc.submitFiles(customer, [
      { name: "photo_id_front", blob: new Blob([secretBytes], { type: "image/jpeg" }), filename: secretName },
    ]);

    const everythingKept = JSON.stringify([save.mock.calls, record]);
    expect(everythingKept).not.toContain(secretBytes);
    expect(everythingKept).not.toContain(secretName);
    const everythingLogged = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    expect(everythingLogged).not.toContain(secretBytes);
    expect(everythingLogged).not.toContain(secretName);
    logged.forEach((spy) => spy.mockRestore());
  });
});

describe("TestAnchorKyc stale customer id (#222)", () => {
  const customer: AnchorCustomer = { sellerId: "seller_1", account: "GSELLER" };

  function makeKyc() {
    const save = vi.fn().mockResolvedValue(undefined);
    const stored: KycRecord = {
      sellerId: "seller_1",
      anchorDomain: "anchor.example",
      account: "GSELLER",
      customerId: "cust_stale",
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      providedFieldStatus: [],
      sentFields: [],
      message: null,
      lastSyncedAt: 0,
      updatedAt: 0,
    };
    const kyc = new TestAnchorKyc({
      discovery: { get: vi.fn().mockResolvedValue({ kycServer: "https://test.example" }) },
      auth: { token: vi.fn().mockResolvedValue("jwt"), anchorDomain: "anchor.example" } as any,
      repo: { get: vi.fn().mockResolvedValue(stored), save },
      profileRepo: { get: vi.fn().mockResolvedValue({ fields: { first_name: "Ada" } }) },
    });
    return { kyc, save };
  }

  const staleEvent = JSON.stringify({ event: "kyc.customer_id.stale", sellerId: "seller_1" });

  it("saves the recovered id and logs a warning when status() recovers from a stale customer id", async () => {
    const { kyc, save } = makeKyc();
    vi.spyOn(sep12, "getSep12Customer").mockResolvedValue({
      customerId: "cust_recovered",
      status: "ACCEPTED",
      requiredFields: [],
      providedFieldStatus: [],
      message: null,
      staleCustomerId: true,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = await kyc.status(customer);

    expect(record.customerId).toBe("cust_recovered");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].customerId).toBe("cust_recovered");
    expect(warnSpy).toHaveBeenCalledWith(staleEvent);
  });

  it("logs a warning when submit() recovers from a stale customer id", async () => {
    const { kyc } = makeKyc();
    vi.spyOn(sep12, "getSep12Customer")
      .mockResolvedValueOnce({
        customerId: "cust_recovered",
        status: "NEEDS_INFO",
        requiredFields: [{ name: "first_name", type: "string", optional: false }],
        providedFieldStatus: [],
        message: null,
        staleCustomerId: true,
      })
      .mockResolvedValueOnce({
        customerId: "cust_recovered",
        status: "ACCEPTED",
        requiredFields: [],
        providedFieldStatus: [],
        message: null,
      });
    vi.spyOn(sep12, "putSep12Customer").mockResolvedValue({ customerId: "cust_recovered" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = await kyc.submit(customer, { first_name: "Ada" });

    expect(record.customerId).toBe("cust_recovered");
    expect(warnSpy).toHaveBeenCalledWith(staleEvent);
  });
});
