import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  toStroops,
  fromStroops,
  NOOP_LOGGER,
  type AttestationPort,
  type AttestationRef,
  type AttestationReceipt,
  type Logger,
} from "@checkout/core";
import { assetCodeBytes, assetCodeFromBytes, refHash, refHashHex, txHashBytes } from "./encoding";

/** Contract error #1 — `AlreadyAttested`. See contracts/quay-attest/src/lib.rs. */
const ALREADY_ATTESTED = /Error\(Contract, #1\)/;

export interface SorobanAttestationConfig {
  /** Deployed `quay-attest` contract id (C…). */
  contractId: string;
  /** Soroban RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * Identity that signs attestations. Must be a funded account — invocations
   * cost fees. Quay uses its SEP-10 signing keypair, so the identity that
   * vouches for a receipt is the same one a wallet already authenticated
   * against.
   */
  attester: Keypair;
  /** Seconds a submitted attestation may take to confirm. Default 30. */
  timeoutSeconds?: number;
  logger?: Logger;
}

/**
 * Writes settlement facts to the `quay-attest` Soroban contract and reads them
 * back.
 *
 * Two properties the callers depend on:
 *
 * - **`attest` is idempotent.** The contract rejects a second write for a
 *   reference with `AlreadyAttested`, and that is treated as success here: the
 *   retry sweep re-runs against links whose first attempt failed, and cannot
 *   distinguish "my earlier attempt actually landed" from "never attested" on
 *   its own. Returning the stored receipt makes the retry converge instead of
 *   thrashing.
 * - **Nothing here is on the settlement path.** Every failure throws for the
 *   caller to swallow. A link is paid because the classic ledger says so.
 */
export class SorobanAttestation implements AttestationPort {
  readonly contractId: string;
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly cfg: Required<Omit<SorobanAttestationConfig, "logger">> & { logger: Logger };

  constructor(config: SorobanAttestationConfig) {
    this.contractId = config.contractId;
    this.contract = new Contract(config.contractId);
    this.server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.cfg = {
      contractId: config.contractId,
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      attester: config.attester,
      timeoutSeconds: config.timeoutSeconds ?? 30,
      logger: config.logger ?? NOOP_LOGGER,
    };
  }

  async attest(input: {
    reference: string;
    txHash: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
    ledger: number;
  }): Promise<AttestationRef> {
    const attesterAddress = this.cfg.attester.publicKey();
    const args = [
      nativeToScVal(Address.fromString(attesterAddress), { type: "address" }),
      xdr.ScVal.scvBytes(refHash(input.reference)),
      xdr.ScVal.scvBytes(txHashBytes(input.txHash)),
      nativeToScVal(toStroops(input.amount), { type: "i128" }),
      xdr.ScVal.scvBytes(assetCodeBytes(input.assetCode)),
      // Native XLM has no issuer to name, so the contract's documented sentinel
      // is the attester's own address. Recorded, never interpreted as authority.
      nativeToScVal(Address.fromString(input.assetIssuer ?? attesterAddress), { type: "address" }),
      nativeToScVal(input.ledger, { type: "u32" }),
    ];

    const source = await this.server.getAccount(attesterAddress);
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(this.contract.call("attest", ...args))
      .setTimeout(this.cfg.timeoutSeconds)
      .build();

    let prepared;
    try {
      prepared = await this.server.prepareTransaction(tx);
    } catch (err) {
      // Simulation is where AlreadyAttested surfaces — the contract returns the
      // error before anything is submitted, so this costs nothing and is the
      // cheap path for a duplicate.
      if (ALREADY_ATTESTED.test(String(err))) return this.existingRef(input.reference);
      throw err;
    }

    prepared.sign(this.cfg.attester);
    const sent = await this.server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`Attestation submit rejected: ${JSON.stringify(sent.errorResult)}`);
    }

    const result = await this.server.pollTransaction(sent.hash, {
      attempts: Math.max(1, this.cfg.timeoutSeconds),
    });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      // A second writer can win the race between our simulation and our
      // submission; the on-chain failure is then AlreadyAttested, and the
      // reference genuinely is attested.
      if (ALREADY_ATTESTED.test(JSON.stringify(result))) return this.existingRef(input.reference);
      throw new Error(`Attestation did not confirm: ${result.status}`);
    }

    this.cfg.logger.info(
      {
        event: "attestation.written",
        reference: input.reference,
        refHash: refHashHex(input.reference),
        contractId: this.contractId,
        attestationTxHash: sent.hash,
        ledger: result.ledger,
      },
      "settlement attested on-chain",
    );

    return {
      contractId: this.contractId,
      txHash: sent.hash,
      ledger: result.ledger,
      attestedAt: Date.now(),
    };
  }

  async verify(reference: string): Promise<AttestationReceipt | null> {
    const source = await this.server.getAccount(this.cfg.attester.publicKey());
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(this.contract.call("verify", xdr.ScVal.scvBytes(refHash(reference))))
      .setTimeout(this.cfg.timeoutSeconds)
      .build();

    // Read-only: simulated, never submitted. Nothing is signed and no fee is
    // paid, which is what makes verification something anyone can do.
    const sim = await this.server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) return null;

    const raw = scValToNative(sim.result.retval) as
      | {
          tx_hash: Uint8Array;
          amount: bigint;
          asset_code: Uint8Array;
          asset_issuer: string;
          ledger: number;
          attested_at: bigint;
          attester: string;
        }
      | null
      | undefined;
    if (!raw) return null;

    const assetCode = assetCodeFromBytes(raw.asset_code);
    return {
      paymentTxHash: Buffer.from(raw.tx_hash).toString("hex"),
      amount: fromStroops(BigInt(raw.amount)),
      assetCode,
      // The contract stores the attester's own address as the issuer sentinel
      // for native XLM (it has no issuer); undo that on the way back out.
      assetIssuer: assetCode === "XLM" && raw.asset_issuer === raw.attester ? null : raw.asset_issuer,
      ledger: raw.ledger,
      // Soroban timestamps are epoch seconds; the domain works in ms.
      attestedAt: Number(raw.attested_at) * 1000,
      attester: raw.attester,
    };
  }

  /**
   * The reference is already in the registry. We can name the contract but not
   * the transaction that wrote it, nor the ledger it landed in — the contract
   * stores the settlement fact, not the invocation that carried it, and that
   * write was never ours to observe. Both stay null rather than being filled
   * with the *payment's* ledger, which the registry does return and which would
   * be a plausible-looking wrong answer in `links.attestation_ledger`.
   *
   * `attestedAt` does come from the registry, so the receipt still carries a
   * timestamp someone else can check.
   */
  private async existingRef(reference: string): Promise<AttestationRef> {
    const existing = await this.verify(reference);
    return {
      contractId: this.contractId,
      txHash: null,
      ledger: null,
      attestedAt: existing?.attestedAt ?? Date.now(),
    };
  }
}
