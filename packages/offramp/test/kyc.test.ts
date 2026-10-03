import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorCustomer, KycFieldSpec, KycRecord, ProvidedFieldStatus } from "@checkout/core";
import { createHash } from "node:crypto";
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

describe("TestAnchorKyc SEP-12 callback registration (#211)", () => {
  const customer: AnchorCustomer = { sellerId: "sel_cb", account: "GSELLER" };
  const ANCHOR = "anchor.example";

  // Spies on ../src/sep12 outlive a test unless reset, and these tests count calls.
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function makeKyc(opts: { callbackBaseUrl?: string; existingHash?: string | null; existing?: boolean } = {}) {
    const save = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    logger.child = () => logger;
    const stored: KycRecord | null =
      opts.existing === false
        ? null
        : {
            sellerId: "sel_cb",
            anchorDomain: ANCHOR,
            account: "GSELLER",
            customerId: "cust_1",
            status: "PROCESSING",
            requiredFields: [],
            providedFields: {},
            providedFieldStatus: [],
            sentFields: [],
            callbackTokenHash: opts.existingHash ?? null,
            message: null,
            lastSyncedAt: 0,
            updatedAt: 0,
          };
    const kyc = new TestAnchorKyc({
      discovery: { get: vi.fn().mockResolvedValue({ kycServer: "https://kyc.example" }) } as any,
      auth: { token: vi.fn().mockResolvedValue("seller-jwt"), anchorDomain: ANCHOR } as any,
      repo: { get: vi.fn().mockResolvedValue(stored), save },
      profileRepo: { get: vi.fn().mockResolvedValue({ fields: { first_name: "Ada" } }) },
      callbackBaseUrl: opts.callbackBaseUrl,
      logger,
    });
    return { kyc, save, logger };
  }

  function stubAnchor() {
    vi.spyOn(sep12, "getSep12Customer")
      .mockResolvedValueOnce({
        customerId: "cust_1",
        status: "NEEDS_INFO",
        requiredFields: [{ name: "first_name", type: "string", optional: false }],
        providedFieldStatus: [],
        message: null,
      })
      .mockResolvedValueOnce({
        customerId: "cust_1",
        status: "PROCESSING",
        requiredFields: [],
        providedFieldStatus: [],
        message: null,
      });
    vi.spyOn(sep12, "putSep12Customer").mockResolvedValue({ customerId: "cust_1" });
    return vi.spyOn(sep12, "putSep12Callback").mockResolvedValue(undefined);
  }

  it("registers a callback after submit, using the seller's own anchor session", async () => {
    const register = stubAnchor();
    const { kyc, save } = makeKyc({ callbackBaseUrl: "https://api.example.com/" });

    const record = await kyc.submit(customer, { first_name: "Ada" });

    expect(register).toHaveBeenCalledTimes(1);
    const [kycServer, jwt, params] = register.mock.calls[0]!;
    expect(kycServer).toBe("https://kyc.example");
    expect(jwt).toBe("seller-jwt");
    expect(params.customerId).toBe("cust_1");

    // /anchor-callbacks/sep12/<the anchor the record is keyed by>/<random token>
    const match = params.url.match(/^https:\/\/api\.example\.com\/anchor-callbacks\/sep12\/anchor\.example\/([0-9a-f]{48})$/);
    expect(match).not.toBeNull();
    const token = match![1]!;
    // only the hash is persisted, never the token itself
    expect(record.callbackTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(save.mock.calls)).not.toContain(token);
  });

  it("registers from status() the first time a customer id is known, but not again", async () => {
    const register = vi.spyOn(sep12, "putSep12Callback").mockResolvedValue(undefined);
    vi.spyOn(sep12, "getSep12Customer").mockResolvedValue({
      customerId: "cust_1",
      status: "PROCESSING",
      requiredFields: [],
      providedFieldStatus: [],
      message: null,
    });

    const first = makeKyc({ callbackBaseUrl: "https://api.example.com" });
    const rec = await first.kyc.status(customer);
    expect(register).toHaveBeenCalledTimes(1);
    expect(rec.callbackTokenHash).toMatch(/^[0-9a-f]{64}$/);

    register.mockClear();
    const already = makeKyc({ callbackBaseUrl: "https://api.example.com", existingHash: "a".repeat(64) });
    const rec2 = await already.kyc.status(customer);
    expect(register).not.toHaveBeenCalled();
    expect(rec2.callbackTokenHash).toBe("a".repeat(64));
  });

  it("skips registration for a localhost origin and logs why", async () => {
    const register = stubAnchor();
    const { kyc, logger } = makeKyc({ callbackBaseUrl: "http://localhost:8787" });

    await kyc.submit(customer, { first_name: "Ada" });

    expect(register).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("localhost"));
  });

  it("does nothing when no public callback origin is configured", async () => {
    const register = stubAnchor();
    const { kyc } = makeKyc({});

    await kyc.submit(customer, { first_name: "Ada" });

    expect(register).not.toHaveBeenCalled();
  });

  it("a failed registration never fails the submission (polling stays the fallback)", async () => {
    const register = stubAnchor();
    register.mockRejectedValue(new Error("anchor said no"));
    const { kyc, logger } = makeKyc({ callbackBaseUrl: "https://api.example.com", existingHash: "b".repeat(64) });

    const record = await kyc.submit(customer, { first_name: "Ada" });

    expect(record.customerId).toBe("cust_1");
    expect(record.callbackTokenHash).toBe("b".repeat(64)); // the previous hash is kept
    expect(logger.warn).toHaveBeenCalled();
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
