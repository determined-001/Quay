import { Keypair, Transaction } from "@stellar/stellar-sdk";
import type { ClientDomainSigner } from "@checkout/offramp";

/**
 * SEP-10 `client_domain` co-signing (issue 3.12).
 *
 * Anchors use the `client_domain` operation to attribute a wallet to the
 * platform it came through. When ANCHOR_CLIENT_DOMAIN is on, Quay asks the
 * anchor for that operation and adds its own signature to the challenge the
 * seller's wallet signed, so the anchor sees Quay as the client.
 *
 * This is the one place a server-held key signs anything, and the key moves no
 * funds. Quay's SEP-10 identity (SERVER_SIGNING_SECRET) is its own login
 * identity, never a seller's wallet. A signature is only ever added to a
 * sequence-0 challenge naming our own `client_domain`, and a sequence-0
 * transaction cannot be submitted to the network: the account's sequence is
 * behind, so the network rejects it. `scripts/check-no-server-signing.mjs`
 * allowlists this file with that reasoning.
 */

export interface ClientDomainSignerOptions {
  /** Quay's SEP-10 signing identity. Holds no funds. */
  keypair: Keypair;
  networkPassphrase: string;
  /** Our public home domain; the challenge's `client_domain` op must name it. */
  clientDomain: string;
}

export function createClientDomainSigner(opts: ClientDomainSignerOptions): ClientDomainSigner {
  const signingKey = opts.keypair.publicKey();
  return {
    signingKey,
    coSign(txXdr: string): string {
      const tx = assertSignableClientDomainChallenge(txXdr, opts.networkPassphrase, opts.clientDomain, signingKey);
      tx.sign(opts.keypair);
      return tx.toXDR();
    },
  };
}

/**
 * Refuses anything that is not the seq-0 manageData challenge we asked for.
 * Exported so the refusal paths are tested directly, rather than only through a
 * signer that would otherwise already have signed.
 */
export function assertSignableClientDomainChallenge(
  xdr: string,
  networkPassphrase: string,
  clientDomain: string,
  signingKey: string,
): Transaction {
  let tx: Transaction;
  try {
    tx = new Transaction(xdr, networkPassphrase);
  } catch {
    throw new Error(`refusing to sign a payload that is not a ${networkPassphrase} transaction`);
  }
  if (Number.parseInt(tx.sequence, 10) !== 0) {
    throw new Error("refusing to sign a transaction with a non-zero sequence number");
  }
  const ops = tx.operations;
  if (ops.length === 0) throw new Error("refusing to sign a challenge with no operations");
  for (const op of ops) {
    if (op.type !== "manageData") {
      throw new Error(`refusing to sign a challenge with a non-manageData operation (${op.type})`);
    }
  }
  const clientDomainOps = ops.filter((op) => op.type === "manageData" && op.name === "client_domain");
  if (clientDomainOps.length !== 1) {
    throw new Error("refusing to sign a challenge that does not carry exactly one client_domain operation");
  }
  const op = clientDomainOps[0]!;
  if (op.type !== "manageData") throw new Error("unreachable"); // Narrow the union to manageData.
  if (op.source !== signingKey) {
    throw new Error("refusing to sign a challenge whose client_domain operation is not sourced by Quay's signing key");
  }
  if (op.value?.toString("utf8") !== clientDomain) {
    throw new Error("refusing to sign a challenge whose client_domain operation names a different domain");
  }
  return tx;
}
