import { describe, it, expect, beforeEach } from "vitest";
import type {
  AttestationPort,
  AttestationRef,
  AttestationReceipt,
  NormalizedPayment,
  MatchOutcome,
  PaymentLink,
  RailPort,
  Seller,
  SellerRepository,
} from "@checkout/core";
import type { StellarConfig } from "@checkout/stellar";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeTelemetryRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const CONTRACT = "CD6AFLZTNUKC6CWXWLAVOEH3FY4ZN47SVX6DPYQBZBTPBBSN6LEFIFZ3";

const stellar: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: ISSUER,
};

const seller: Seller = {
  id: "sel_1",
  name: "Seller",
  wallet: DEST,
  payoutFields: null,
  createdAt: 0,
};

const sellers: SellerRepository = {
  async getDefault() {
    return seller;
  },
  async findById() {
    return seller;
  },
  async findByWallet() {
    return seller;
  },
  async createIfAbsent() {
    return seller;
  },
  async savePayoutFields() {},
};

const rail: RailPort = {
  buildRequest: () => ({
    uri: "web+stellar:pay",
    destination: DEST,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    memo: "ref_1",
  }),
  isValidDestination: () => true,
  async assertCanReceive() {},
};

/**
 * Records every call so a test can assert on exactly what was sent to the
 * registry — the arguments are the part that becomes permanent on-chain.
 */
class RecordingAttestation implements AttestationPort {
  readonly contractId = CONTRACT;
  readonly calls: Parameters<AttestationPort["attest"]>[0][] = [];
  /** Set to make the next N calls fail, mimicking an unreachable RPC. */
  failures = 0;
  /** When true, `attest` resolves with a null txHash — the "already in the
   *  registry, written by someone else" shape. */
  reportsExisting = false;

  async attest(input: Parameters<AttestationPort["attest"]>[0]): Promise<AttestationRef> {
    this.calls.push(input);
    if (this.failures > 0) {
      this.failures--;
      throw new Error("soroban rpc unreachable");
    }
    return {
      contractId: CONTRACT,
      txHash: this.reportsExisting ? null : "soroban_tx_1",
      ledger: this.reportsExisting ? null : 9001,
      attestedAt: 1_700_000_500_000,
    };
  }

  async verify(): Promise<AttestationReceipt | null> {
    return null;
  }
}

function makeService(attestation?: AttestationPort) {
  const links = new FakeLinkRepository();
  const webhooks = new FakeWebhookRepository();
  const service = new LinkService({
    links,
    sellers,
    webhooks,
    rail,
    offramp: new ScriptedOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    attestation,
    telemetry: new FakeTelemetryRepository(),
    stellar,
    correlation: "memo",
  });
  return { service, links };
}

function payment(over: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    txHash: "tx_settle_1",
    pagingToken: "1",
    from: "GBUYER",
    to: DEST,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    memo: "pl_ref1",
    memoType: "text",
    toMuxedId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ledger: 55_123,
    ...over,
  };
}

async function settle(
  service: LinkService,
  links: FakeLinkRepository,
  over: Partial<PaymentLink> = {},
): Promise<PaymentLink> {
  const link = makeLink({ status: "active", txHash: null, paidAmount: null, ...over });
  await links.save(link);
  const outcome: MatchOutcome = {
    kind: "paid",
    link,
    overpaid: false,
    receivedTotal: "10",
    overpaidAmount: "0",
  };
  await service.applyMatch(payment(), outcome);
  await service.whenAttestationsSettled();
  return links.get(link.id)!;
}

describe("settlement attestation", () => {
  let attester: RecordingAttestation;

  beforeEach(() => {
    attester = new RecordingAttestation();
  });

  it("attests a settlement and persists the reference on the link", async () => {
    const { service, links } = makeService(attester);
    const settled = await settle(service, links);

    expect(settled.status).toBe("paid");
    expect(settled.attestationContractId).toBe(CONTRACT);
    expect(settled.attestationTxHash).toBe("soroban_tx_1");
    expect(settled.attestationLedger).toBe(9001);
    expect(settled.attestedAt).toBe(1_700_000_500_000);
  });

  it("sends the reference, payment hash, asset and settling ledger to the registry", async () => {
    const { service, links } = makeService(attester);
    await settle(service, links);

    expect(attester.calls).toEqual([
      {
        reference: "pl_ref1",
        txHash: "tx_settle_1",
        amount: "10",
        assetCode: "USDC",
        assetIssuer: ISSUER,
        // The ledger the payment actually settled in, not the one the
        // attestation lands in — the two are on different ledgers entirely.
        ledger: 55_123,
      },
    ]);
  });

  // The invariant the whole design rests on: a payment is settled because the
  // classic ledger says so. Attestation is a claim *about* that fact and may
  // never gate it.
  it("still marks the link paid when the registry is unreachable", async () => {
    attester.failures = 1;
    const { service, links } = makeService(attester);
    const settled = await settle(service, links);

    expect(settled.status).toBe("paid");
    expect(settled.txHash).toBe("tx_settle_1");
    expect(settled.paidAmount).toBe("10");
    expect(settled.attestedAt).toBeNull();
    expect(settled.attestationContractId).toBeNull();
  });

  it("marks the link paid when no attester is configured at all", async () => {
    const { service, links } = makeService(undefined);
    const settled = await settle(service, links);

    expect(settled.status).toBe("paid");
    expect(settled.attestedAt).toBeNull();
  });

  it("records attestedAt even when the receipt was already in the registry", async () => {
    // A duplicate returns neither transaction hash nor ledger of ours — the
    // registry stores the fact, not the invocation that carried it. `attestedAt`
    // must still be set, or the sweep would re-attempt this link forever.
    attester.reportsExisting = true;
    const { service, links } = makeService(attester);
    const settled = await settle(service, links);

    expect(settled.attestationTxHash).toBeNull();
    expect(settled.attestationLedger).toBeNull();
    expect(settled.attestationContractId).toBe(CONTRACT);
    expect(settled.attestedAt).toBe(1_700_000_500_000);
    expect(await links.listUnattested(10)).toEqual([]);
  });
});

describe("sweepUnattested", () => {
  it("attests a settled link whose first attempt failed", async () => {
    const attester = new RecordingAttestation();
    attester.failures = 1;
    const { service, links } = makeService(attester);
    const settled = await settle(service, links);
    expect(settled.attestedAt).toBeNull();

    const attested = await service.sweepUnattested(10);
    await service.whenAttestationsSettled();

    expect(attested).toBe(1);
    expect(links.get(settled.id)!.attestedAt).toBe(1_700_000_500_000);
    // Second call carries the same facts — the ledger survived in the payment
    // ledger row, not in the watcher tick that has long since finished.
    expect(attester.calls).toHaveLength(2);
    expect(attester.calls[1]).toMatchObject({ txHash: "tx_settle_1", ledger: 55_123 });
  });

  it("does not re-attest a link that already carries an attestation", async () => {
    const attester = new RecordingAttestation();
    const { service, links } = makeService(attester);
    await settle(service, links);
    expect(attester.calls).toHaveLength(1);

    const attested = await service.sweepUnattested(10);
    await service.whenAttestationsSettled();

    expect(attested).toBe(0);
    expect(attester.calls).toHaveLength(1);
  });

  it("leaves an unpaid link alone", async () => {
    const attester = new RecordingAttestation();
    const { service, links } = makeService(attester);
    await links.save(makeLink({ status: "active", txHash: null }));

    expect(await service.sweepUnattested(10)).toBe(0);
    expect(attester.calls).toHaveLength(0);
  });

  it("skips a settled link whose payment predates the ledger column", async () => {
    // Guessing a ledger would put a fact that is simply false into a registry
    // that can never be corrected. Staying unattested is the honest outcome.
    const attester = new RecordingAttestation();
    const { service, links } = makeService(attester);
    await links.save(makeLink({ status: "paid", txHash: "tx_ancient" }));

    expect(await service.sweepUnattested(10)).toBe(0);
    expect(attester.calls).toHaveLength(0);
  });

  it("does nothing when no attester is configured", async () => {
    const { service, links } = makeService(undefined);
    await settle(service, links);
    expect(await service.sweepUnattested(10)).toBe(0);
  });
});
