import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnchorCustomer,
  KycRecord,
  KycRepository,
  Logger,
  PrefillConsent,
  PrefillConsentRepository,
} from "@checkout/core";
import { AnchorOffRamp } from "../src/anchor";
import type { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { SEP24_PREFILL_FIELDS, isPrefillField, pickPrefill } from "../src/sep9";
import { FakeOffRampStateRepository } from "./fake-state";

// Seller values that must reach the anchor only when consented, and never a log.
const PROVIDED = {
  first_name: "Ada",
  last_name: "Lovelace",
  email_address: "ada@example.org",
  birth_date: "1815-12-10",
  id_number: "A1234567",
  photo_id_front: "RAW-BYTES",
  favourite_colour: "green",
};
const SECRET_VALUES = ["Ada", "Lovelace", "ada@example.org", "1815-12-10", "A1234567", "RAW-BYTES", "BANK-9999"];

describe("pickPrefill", () => {
  it("returns nothing without consent", () => {
    expect(pickPrefill(PROVIDED, [])).toEqual({});
  });

  it("returns exactly the consented, allowlisted fields that have a value", () => {
    expect(pickPrefill(PROVIDED, ["first_name"])).toEqual({ first_name: "Ada" });
    expect(pickPrefill(PROVIDED, ["first_name", "last_name", "mobile_number"])).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
    });
  });

  it("never returns id_number, binary or unlisted fields, even if the seller consented to them", () => {
    expect(pickPrefill(PROVIDED, ["id_number", "photo_id_front", "favourite_colour", "dest", "account"])).toEqual({});
  });

  it("skips blank values", () => {
    expect(pickPrefill({ first_name: "  ", city: "" }, ["first_name", "city"])).toEqual({});
  });

  it("the allowlist is the natural-person set from the issue and excludes id_number and binary fields", () => {
    for (const name of [
      "first_name", "last_name", "email_address", "mobile_number", "address", "city", "state_or_province",
      "postal_code", "address_country_code", "birth_date", "bank_account_number", "bank_number", "bank_branch_number",
    ]) {
      expect(isPrefillField(name)).toBe(true);
    }
    expect(SEP24_PREFILL_FIELDS).not.toContain("id_number");
    expect(SEP24_PREFILL_FIELDS.some((n) => n.startsWith("photo_"))).toBe(false);
  });
});

describe("AnchorOffRamp.initiate prefill (issue 3.17)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const SELLER: AnchorCustomer = { sellerId: "sel_1", account: "GSELLER" };
  const discovery = {
    homeDomain: "anchor.example",
    get: async () => ({ homeDomain: "anchor.example", transferServerSep24: "https://anchor.example/sep24" }),
  } as unknown as AnchorDiscovery;
  const auth = { token: async () => "jwt" } as unknown as SellerAnchorAuth;

  function logCapture() {
    const lines: unknown[] = [];
    const log = (o: unknown, msg?: string) => void lines.push(o, msg);
    const l = { debug: log, info: log, warn: log, error: log, child: () => l } as unknown as Logger;
    return { logger: l, lines };
  }

  async function run(opts: {
    consent: string[] | null;
    provided?: Record<string, string>;
    payoutFields?: Record<string, string>;
    withPrefill?: boolean;
    consentFor?: string;
  }) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return Response.json({ id: "wd_1", url: "https://anchor.example/ui", type: "interactive_customer_info_needed" });
      }),
    );
    const state = new FakeOffRampStateRepository();
    await state.saveQuote({
      quoteId: "q1",
      linkId: "l1",
      sellAsset: { code: "USDC", issuer: "GISSUER" },
      sellAmount: "10",
      buyCurrency: "NGN",
      price: "1",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const record = {
      sellerId: SELLER.sellerId,
      anchorDomain: "anchor.example",
      providedFields: opts.provided ?? PROVIDED,
    } as unknown as KycRecord;
    const kyc = { get: vi.fn(async () => record) } as unknown as KycRepository;
    const consents: PrefillConsentRepository = {
      get: async (sellerId, anchorDomain) =>
        opts.consent && anchorDomain === (opts.consentFor ?? "anchor.example")
          ? ({ sellerId, anchorDomain, fields: opts.consent, grantedAt: 1 } satisfies PrefillConsent)
          : null,
      set: async () => null,
      list: async () => [],
    };
    const audit = vi.fn(async () => {});
    const { logger, lines } = logCapture();
    const offramp = new AnchorOffRamp({
      discovery,
      auth,
      state,
      logger,
      ...(opts.withPrefill === false ? {} : { prefill: { kyc, consents, audit } }),
    });
    await offramp.initiate({
      linkId: "l1",
      quoteId: "q1",
      payout: { currency: "NGN", fields: opts.payoutFields ?? {} },
      customer: SELLER,
    });
    return { body: bodies[0]!, lines, audit, kyc };
  }

  it("never copies a payout field such as dest into the interactive POST body", async () => {
    const { body } = await run({
      consent: ["first_name"],
      payoutFields: { dest: "BANK-9999", dest_extra: "044", bank_account_number: "BANK-9999" },
    });
    expect(JSON.stringify(body)).not.toContain("BANK-9999");
    expect(body).not.toHaveProperty("dest");
    expect(body).not.toHaveProperty("dest_extra");
    expect(body).not.toHaveProperty("bank_account_number");
  });

  it("with no consent record, the body carries no SEP-9 keys at all", async () => {
    const { body, audit, kyc } = await run({ consent: null });
    expect(Object.keys(body).sort()).toEqual(["account", "amount", "asset_code", "asset_issuer", "quote_id"]);
    expect(audit).not.toHaveBeenCalled();
    expect(kyc.get).not.toHaveBeenCalled(); // nothing on file is even read without consent
  });

  it("with an empty consent record, the body carries no SEP-9 keys either", async () => {
    const { body } = await run({ consent: [] });
    expect(body).not.toHaveProperty("first_name");
  });

  it("with consent for first_name only, the body carries exactly first_name", async () => {
    const { body, audit } = await run({ consent: ["first_name"] });
    expect(body).toMatchObject({ first_name: "Ada", account: "GSELLER", asset_code: "USDC" });
    const sep9 = Object.keys(body).filter((k) => !["account", "amount", "asset_code", "asset_issuer", "quote_id"].includes(k));
    expect(sep9).toEqual(["first_name"]);
    expect(audit).toHaveBeenCalledWith(SELLER, ["first_name"]);
  });

  it("drops consented names that are not allowlisted (id_number, binary)", async () => {
    const { body } = await run({ consent: ["first_name", "id_number", "photo_id_front"] });
    expect(body).not.toHaveProperty("id_number");
    expect(body).not.toHaveProperty("photo_id_front");
    expect(body).toHaveProperty("first_name", "Ada");
  });

  it("a consent given to another anchor does not apply", async () => {
    const { body } = await run({ consent: ["first_name"], consentFor: "other.example" });
    expect(body).not.toHaveProperty("first_name");
  });

  it("sends nothing when no prefill source is wired", async () => {
    const { body } = await run({ consent: ["first_name"], withPrefill: false });
    expect(body).not.toHaveProperty("first_name");
  });

  it("logs the field names in anchor.sep24.withdraw.start and never a value", async () => {
    const { lines } = await run({ consent: ["last_name", "first_name"] });
    const start = lines.find((l) => (l as { event?: string })?.event === "anchor.sep24.withdraw.start");
    expect(start).toMatchObject({ prefillFields: ["first_name", "last_name"] });
    const all = JSON.stringify(lines);
    for (const value of SECRET_VALUES) expect(all).not.toContain(value);
  });

  it("a failure reading the profile starts the withdrawal without prefill instead of failing it", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        return Response.json({ id: "wd_1", url: "https://anchor.example/ui", type: "interactive_customer_info_needed" });
      }),
    );
    const state = new FakeOffRampStateRepository();
    await state.saveQuote({
      quoteId: "q1", linkId: "l1", sellAsset: { code: "USDC", issuer: "G" }, sellAmount: "10",
      buyCurrency: "NGN", price: "1", expiresAt: Date.now() + 60_000, createdAt: Date.now(),
    });
    const { logger, lines } = logCapture();
    const offramp = new AnchorOffRamp({
      discovery, auth, state, logger,
      prefill: {
        kyc: { get: async () => { throw new Error("cannot decrypt Ada"); } } as unknown as KycRepository,
        consents: { get: async () => ({ sellerId: "sel_1", anchorDomain: "anchor.example", fields: ["first_name"], grantedAt: 1 }), set: async () => null, list: async () => [] },
      },
    });

    const result = await offramp.initiate({ linkId: "l1", quoteId: "q1", payout: { currency: "NGN", fields: {} }, customer: SELLER });

    expect(result.kind).toBe("interactive");
    expect(bodies[0]).not.toHaveProperty("first_name");
    expect(JSON.stringify(lines)).not.toContain("Ada"); // only the error class is logged, not its message
  });
});
