import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import {
  assertSignableClientDomainChallenge,
  createClientDomainSigner,
} from "../src/services/client-domain-signer";

// ---------------------------------------------------------------------------
// The one place a server-held key signs anything. It may only add a signature
// to a sequence-0 manageData challenge that names Quay's own client_domain and
// is sourced by Quay's SEP-10 identity. Everything else is refused, because a
// signature that could be attached to a submittable transaction is the exact
// custody line this codebase never crosses.
// ---------------------------------------------------------------------------

const HOME = "quay.example";
const anchorKey = Keypair.random();
const quayKey = Keypair.random();
const seller = Keypair.random();

/** A challenge the anchor builds for a client that asked for our client_domain. */
function challenge(opts: { clientDomain?: string; clientSigningKey?: Keypair } = {}) {
  return WebAuth.buildChallengeTx(
    anchorKey,
    seller.publicKey(),
    HOME,
    300,
    Networks.TESTNET,
    HOME,
    null,
    opts.clientDomain ?? HOME,
    (opts.clientSigningKey ?? quayKey).publicKey(),
  );
}

const signer = () => createClientDomainSigner({ keypair: quayKey, networkPassphrase: Networks.TESTNET, clientDomain: HOME });

describe("createClientDomainSigner", () => {
  it("exposes Quay's public signing key and co-signs a valid challenge", () => {
    const s = signer();
    expect(s.signingKey).toBe(quayKey.publicKey());

    const walletSigned = TransactionBuilder.fromXDR(challenge(), Networks.TESTNET);
    walletSigned.sign(seller);
    const relayed = s.coSign(walletSigned.toXDR());

    // The anchor can now verify both the seller's wallet and Quay's client_domain signature.
    const found = WebAuth.verifyChallengeTxSigners(relayed, anchorKey.publicKey(), Networks.TESTNET, [seller.publicKey()], HOME, HOME);
    expect(found).toContain(seller.publicKey());
  });

  it("refuses a challenge with a non-zero sequence number", () => {
    const tx = new TransactionBuilder(new Account(anchorKey.publicKey(), "0"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
    })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48), source: seller.publicKey() }))
      .addOperation(Operation.manageData({ name: "client_domain", value: HOME, source: quayKey.publicKey() }))
      .build();
    tx.sign(anchorKey);
    expect(tx.sequence).not.toBe("0");
    expect(() => assertSignableClientDomainChallenge(tx.toXDR(), Networks.TESTNET, HOME, quayKey.publicKey())).toThrow(
      /non-zero sequence/,
    );
  });

  it("refuses a transaction that carries a payment", () => {
    const tx = new TransactionBuilder(new Account(anchorKey.publicKey(), "-1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
    })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48), source: seller.publicKey() }))
      .addOperation(Operation.manageData({ name: "client_domain", value: HOME, source: quayKey.publicKey() }))
      .addOperation(Operation.payment({ destination: seller.publicKey(), asset: Asset.native(), amount: "1" }))
      .build();
    tx.sign(anchorKey);
    expect(() => assertSignableClientDomainChallenge(tx.toXDR(), Networks.TESTNET, HOME, quayKey.publicKey())).toThrow(
      /non-manageData operation/,
    );
  });

  it("refuses a challenge whose client_domain names a different domain", () => {
    expect(() =>
      assertSignableClientDomainChallenge(challenge({ clientDomain: "evil.example" }), Networks.TESTNET, HOME, quayKey.publicKey()),
    ).toThrow(/names a different domain/);
  });

  it("refuses a challenge whose client_domain is sourced by a different key", () => {
    const other = Keypair.random();
    expect(() =>
      assertSignableClientDomainChallenge(challenge({ clientSigningKey: other }), Networks.TESTNET, HOME, quayKey.publicKey()),
    ).toThrow(/not sourced by Quay's signing key/);
  });

  it("refuses a challenge with no client_domain op at all", () => {
    const plain = WebAuth.buildChallengeTx(anchorKey, seller.publicKey(), HOME, 300, Networks.TESTNET, HOME);
    expect(() => assertSignableClientDomainChallenge(plain, Networks.TESTNET, HOME, quayKey.publicKey())).toThrow(
      /exactly one client_domain/,
    );
  });

  it("refuses a payload that is not a transaction on our network", () => {
    expect(() => assertSignableClientDomainChallenge("not-an-xdr", Networks.TESTNET, HOME, quayKey.publicKey())).toThrow(
      /not a Test SDF Network/,
    );
  });
});
