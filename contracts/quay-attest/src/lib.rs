#![no_std]

//! # quay-attest — on-chain settlement attestations
//!
//! Quay is a non-custodial checkout: the buyer pays USDC straight to the
//! seller's own Stellar wallet, and a backend watcher matches that payment to a
//! payment link and marks it paid. The weak point in that story is the last
//! step — "marked paid" lives in Quay's database, so a receipt is only as
//! trustworthy as the operator serving it.
//!
//! This contract removes that trust requirement. When the watcher confirms a
//! settlement it writes an attestation here, and anyone can then verify a
//! receipt against the ledger without asking Quay anything.
//!
//! ## What it deliberately does not do
//!
//! It never holds, moves, or has any authority over funds. Quay's whole
//! regulatory posture rests on value never passing through it (see
//! `docs/PROPOSAL.md` §6), so an escrow-shaped contract would undo the thing
//! this codebase is organised around. This is an append-only registry of facts
//! about payments that already settled on the classic ledger.
//!
//! ## Privacy
//!
//! The key is `sha256(reference)`, never the reference itself. A payment
//! reference is embedded in the Stellar memo and is effectively a short
//! invoice identifier, so publishing a list of them would leak a seller's
//! invoice volume and sequence to any ledger observer. Hashing keeps the
//! registry verifiable by anyone *given* a reference while revealing nothing to
//! someone merely reading the contract's storage.
//!
//! ## Authority
//!
//! Each attestation records the attester and requires their signature. The
//! contract does not decide who is allowed to attest — a verifier decides
//! whether it trusts a given attester, exactly as it would decide whether to
//! trust an issuer. What the contract guarantees is that an attestation cannot
//! be forged in someone else's name, and cannot be silently rewritten: the
//! first attestation for a reference wins.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, BytesN, Env};

/// Ledger entries are bumped to roughly 30 days and extended on read. An
/// attestation that nobody ever verifies is allowed to expire; one that is
/// checked periodically stays live indefinitely.
const TTL_THRESHOLD: u32 = 17_280 * 15;
const TTL_EXTEND: u32 = 17_280 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Receipt {
    /// Hash of the classic Stellar transaction that delivered the payment.
    pub tx_hash: BytesN<32>,
    /// Amount received, in stroops (7 decimal places), matching the classic
    /// ledger's own representation so the two can be compared exactly.
    pub amount: i128,
    /// Asset code as 4 or 12 bytes, right-padded — `USDC` is `b"USDC"`.
    pub asset_code: BytesN<12>,
    /// Issuer of the asset. Native XLM attestations use the attester's own
    /// address as a sentinel, since there is no issuer to name.
    pub asset_issuer: Address,
    /// Classic ledger sequence the payment settled in.
    pub ledger: u32,
    /// Ledger timestamp when the attestation was written.
    pub attested_at: u64,
    /// Who vouched for this. Required to have authorized the call.
    pub attester: Address,
}

#[contracttype]
pub enum DataKey {
    /// sha256(reference) -> Receipt
    Receipt(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// A receipt already exists for this reference. Attestations are
    /// append-only: allowing an overwrite would let an attester rewrite history
    /// after the fact, which is precisely the property this contract exists to
    /// deny.
    AlreadyAttested = 1,
    /// `amount` must be positive — a settlement of zero or less is not a
    /// settlement.
    InvalidAmount = 2,
}

#[contract]
pub struct QuayAttest;

#[contractimpl]
impl QuayAttest {
    /// Record that a payment settled against `ref_hash`.
    ///
    /// Fails with [`Error::AlreadyAttested`] if the reference already carries a
    /// receipt, so a caller can retry safely: a duplicate is a definite no-op
    /// rather than a silent overwrite.
    pub fn attest(
        env: Env,
        attester: Address,
        ref_hash: BytesN<32>,
        tx_hash: BytesN<32>,
        amount: i128,
        asset_code: BytesN<12>,
        asset_issuer: Address,
        ledger: u32,
    ) -> Result<(), Error> {
        attester.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Receipt(ref_hash.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyAttested);
        }

        let receipt = Receipt {
            tx_hash,
            amount,
            asset_code,
            asset_issuer,
            ledger,
            attested_at: env.ledger().timestamp(),
            attester,
        };

        env.storage().persistent().set(&key, &receipt);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);

        Ok(())
    }

    /// Look up the receipt for a reference hash. Read-only and unauthenticated
    /// — verification is the entire point, so anyone may call it.
    pub fn verify(env: Env, ref_hash: BytesN<32>) -> Option<Receipt> {
        let key = DataKey::Receipt(ref_hash);
        let receipt: Option<Receipt> = env.storage().persistent().get(&key);
        if receipt.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        }
        receipt
    }

    /// Whether a reference has been attested. Cheaper than [`Self::verify`]
    /// when the caller only needs existence.
    pub fn attested(env: Env, ref_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Receipt(ref_hash))
    }
}

mod test;
