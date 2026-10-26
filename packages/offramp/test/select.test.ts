import { describe, expect, it, vi } from "vitest";
import {
  OffRampJobNotFoundError,
  type AnchorCustomer,
  type Logger,
  type OffRampPort,
  type StoredOffRampJob,
} from "@checkout/core";
import {
  AnchorCapabilityError,
  SelectingOffRamp,
  chooseProtocol,
  parseStellarToml,
  protocolOfJob,
  type OffRampProtocol,
  type Sep1DiscoveryInfo,
} from "../src/index";
import { FakeOffRampStateRepository } from "./fake-state";

const SIGNING = 'SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"\n';
const SEP6 = 'TRANSFER_SERVER = "https://a.example/sep6"\n';
const SEP24 = 'TRANSFER_SERVER_SEP0024 = "https://a.example/sep24"\n';

const toml = (body: string) => parseStellarToml(SIGNING + body, "a.example");
const BOTH = toml(SEP6 + SEP24);
const SEP6_ONLY = toml(SEP6);
const SEP24_ONLY = toml(SEP24);
const NEITHER = toml("");

const customer: AnchorCustomer = { sellerId: "sel_1", account: "GSELLER" };

function adapter(tag: string) {
  const port = {
    mode: "seller_initiated" as const,
    offrampRequirements: vi.fn().mockResolvedValue({ types: [], defaultType: tag }),
    quote: vi.fn().mockResolvedValue({ quoteId: tag }),
    initiate: vi.fn().mockResolvedValue({ kind: "fields", jobId: tag }),
    status: vi.fn().mockResolvedValue({ jobId: tag, status: "pending" }),
    indicativePrices: vi.fn().mockResolvedValue([]),
  };
  return port satisfies Record<string, unknown> as typeof port & OffRampPort;
}

function logger() {
  const lines: Record<string, unknown>[] = [];
  const log = (o: unknown) => void (typeof o === "object" && o && lines.push(o as Record<string, unknown>));
  const l: Logger = { debug: log, info: log, warn: log, error: log, child: () => l } as unknown as Logger;
  return { logger: l, lines };
}

function selecting(protocol: OffRampProtocol, info: Sep1DiscoveryInfo | (() => Sep1DiscoveryInfo)) {
  const sep6 = adapter("sep6");
  const sep24 = adapter("sep24");
  const state = new FakeOffRampStateRepository();
  const get = vi.fn(async () => (typeof info === "function" ? info() : info));
  const { logger: log, lines } = logger();
  const sel = new SelectingOffRamp({
    discovery: { homeDomain: "a.example", get },
    protocol,
    sep6,
    sep24,
    state,
    logger: log,
  });
  return { sel, sep6, sep24, state, get, lines };
}

const QUOTE_INPUT = {
  linkId: "l1",
  sourceAsset: { code: "USDC", issuer: "GISSUER" },
  sourceAmount: "10",
  targetCurrency: "NGN",
  customer,
};

function job(jobId: string, anchor: string): StoredOffRampJob {
  return {
    jobId,
    linkId: "l1",
    anchor,
    sellerId: "sel_1",
    account: "GSELLER",
    targetCurrency: "NGN",
    targetAmount: "1",
    rate: "1",
    status: "pending",
    externalStatus: null,
    lastError: null,
    transferNotifiedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("chooseProtocol", () => {
  it("auto prefers SEP-6 when both are declared, else whichever is", () => {
    expect(chooseProtocol("auto", BOTH)).toBe("sep6");
    expect(chooseProtocol("auto", SEP6_ONLY)).toBe("sep6");
    expect(chooseProtocol("auto", SEP24_ONLY)).toBe("sep24");
  });

  it("auto with neither declared says so and lists what is declared", () => {
    expect(() => chooseProtocol("auto", NEITHER)).toThrow(AnchorCapabilityError);
    expect(() => chooseProtocol("auto", NEITHER)).toThrow(/declared: none/);
  });

  it("a forced protocol the anchor does not declare throws with the declared list", () => {
    expect(() => chooseProtocol("sep24", SEP6_ONLY)).toThrow(
      "Anchor a.example does not declare SEP-24 (TRANSFER_SERVER_SEP0024) in its stellar.toml (declared: sep6, sep12)",
    );
    expect(() => chooseProtocol("sep6", SEP24_ONLY)).toThrow(/SEP-6 \(TRANSFER_SERVER\).*declared: sep24, sep12/);
  });

  it("a forced protocol wins over auto's preference when the anchor declares it", () => {
    expect(chooseProtocol("sep24", BOTH)).toBe("sep24");
    expect(chooseProtocol("sep6", BOTH)).toBe("sep6");
  });
});

describe("SelectingOffRamp", () => {
  it("auto sends a SEP-24-only anchor's work to the SEP-24 adapter", async () => {
    const { sel, sep6, sep24 } = selecting("auto", SEP24_ONLY);
    await sel.quote(QUOTE_INPUT);
    await sel.offrampRequirements("USDC", customer);
    expect(sep24.quote).toHaveBeenCalledTimes(1);
    expect(sep24.offrampRequirements).toHaveBeenCalledTimes(1);
    expect(sep6.quote).not.toHaveBeenCalled();
  });

  it("auto sends work to SEP-6 when both are declared", async () => {
    const { sel, sep6, sep24 } = selecting("auto", BOTH);
    await sel.quote(QUOTE_INPUT);
    await sel.initiate({ linkId: "l1", quoteId: "q", payout: {} as never, customer });
    expect(sep6.quote).toHaveBeenCalledTimes(1);
    expect(sep6.initiate).toHaveBeenCalledTimes(1);
    expect(sep24.quote).not.toHaveBeenCalled();
  });

  it("neither declared: the first use throws a clear error and reaches no adapter", async () => {
    const { sel, sep6, sep24 } = selecting("auto", NEITHER);
    await expect(sel.quote(QUOTE_INPUT)).rejects.toThrow(AnchorCapabilityError);
    expect(sep6.quote).not.toHaveBeenCalled();
    expect(sep24.quote).not.toHaveBeenCalled();
  });

  it("a forced protocol the anchor lacks fails at first use, naming the declared list", async () => {
    const { sel } = selecting("sep24", SEP6_ONLY);
    await expect(sel.quote(QUOTE_INPUT)).rejects.toThrow(/does not declare SEP-24.*declared: sep6, sep12/);
  });

  it("logs the chosen protocol once, however many calls follow", async () => {
    const { sel, lines, get } = selecting("auto", SEP24_ONLY);
    await sel.protocol();
    await sel.quote(QUOTE_INPUT);
    await sel.quote(QUOTE_INPUT);
    const logged = lines.filter((l) => l.event === "offramp.protocol");
    expect(logged).toEqual([
      expect.objectContaining({ event: "offramp.protocol", protocol: "sep24", preference: "auto", declared: ["sep24", "sep12"] }),
    ]);
    expect(get).toHaveBeenCalledTimes(1); // discovery resolved once
  });

  it("does not remember a choice made from a failed stellar.toml fetch", async () => {
    const fallback: Sep1DiscoveryInfo = { ...BOTH, fallback: true };
    let current: Sep1DiscoveryInfo = fallback;
    const { sel, sep6, sep24, lines } = selecting("auto", () => current);

    await sel.quote(QUOTE_INPUT); // guessed layout: SEP-6, used for this call only
    expect(sep6.quote).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.event === "offramp.protocol")).toBe(false);

    current = SEP24_ONLY; // the TOML is readable now
    await sel.quote(QUOTE_INPUT);
    expect(sep24.quote).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.event === "offramp.protocol")).toHaveLength(1);
  });

  describe("status() follows the job, not the preference", () => {
    it("polls a job started over SEP-24 through SEP-24 even after the preference moves to sep6", async () => {
      const { sel, sep6, sep24, state } = selecting("sep6", BOTH);
      await state.saveJob(job("j24", "a.example#sep24"));
      await state.saveJob(job("j6", "a.example"));

      await sel.status("j24");
      expect(sep24.status).toHaveBeenCalledWith("j24", undefined);
      expect(sep6.status).not.toHaveBeenCalled();

      await sel.status("j6");
      expect(sep6.status).toHaveBeenCalledWith("j6", undefined);
    });

    it("needs no protocol resolution (and so no discovery) to poll", async () => {
      const { sel, state, get } = selecting("auto", NEITHER);
      await state.saveJob(job("j24", "a.example#sep24"));
      await expect(sel.status("j24")).resolves.toMatchObject({ jobId: "sep24" });
      expect(get).not.toHaveBeenCalled();
    });

    it("an unknown job is OffRampJobNotFoundError", async () => {
      const { sel } = selecting("auto", BOTH);
      await expect(sel.status("nope")).rejects.toBeInstanceOf(OffRampJobNotFoundError);
    });
  });

  it("indicative prices come from SEP-38 via the SEP-6 adapter whichever protocol is chosen", async () => {
    const { sel, sep6, sep24 } = selecting("auto", SEP24_ONLY);
    await sel.indicativePrices({ sourceAsset: { code: "USDC", issuer: "G" }, sourceAmount: "10" });
    expect(sep6.indicativePrices).toHaveBeenCalledTimes(1);
    expect(sep24.indicativePrices).not.toHaveBeenCalled();
  });
});

describe("protocolOfJob", () => {
  it("reads the label the SEP-24 adapter writes; a bare domain is SEP-6", () => {
    expect(protocolOfJob("anchor.example#sep24")).toBe("sep24");
    expect(protocolOfJob("anchor.example")).toBe("sep6");
    expect(protocolOfJob("mock")).toBe("sep6");
  });
});
