#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

struct Harness {
    env: Env,
    client: QuayAttestClient<'static>,
    attester: Address,
    issuer: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(QuayAttest, ());
    let client = QuayAttestClient::new(&env, &contract_id);
    let attester = Address::generate(&env);
    let issuer = Address::generate(&env);
    Harness {
        env,
        client,
        attester,
        issuer,
    }
}

fn usdc(env: &Env) -> BytesN<12> {
    let mut code = [0u8; 12];
    code[..4].copy_from_slice(b"USDC");
    BytesN::from_array(env, &code)
}

fn hash(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

#[test]
fn attest_then_verify_round_trips_every_field() {
    let h = setup();
    h.env.ledger().set_timestamp(1_700_000_000);

    let ref_hash = hash(&h.env, 1);
    let tx_hash = hash(&h.env, 2);

    h.client.attest(
        &h.attester,
        &ref_hash,
        &tx_hash,
        &15_000_000i128,
        &usdc(&h.env),
        &h.issuer,
        &42u32,
    );

    let receipt = h.client.verify(&ref_hash).expect("attested");
    assert_eq!(receipt.tx_hash, tx_hash);
    assert_eq!(receipt.amount, 15_000_000);
    assert_eq!(receipt.asset_code, usdc(&h.env));
    assert_eq!(receipt.asset_issuer, h.issuer);
    assert_eq!(receipt.ledger, 42);
    assert_eq!(receipt.attested_at, 1_700_000_000);
    assert_eq!(receipt.attester, h.attester);
}

#[test]
fn verify_returns_none_for_an_unknown_reference() {
    let h = setup();
    assert!(h.client.verify(&hash(&h.env, 9)).is_none());
    assert!(!h.client.attested(&hash(&h.env, 9)));
}

#[test]
fn attested_reports_existence_without_reading_the_receipt() {
    let h = setup();
    let ref_hash = hash(&h.env, 3);
    assert!(!h.client.attested(&ref_hash));

    h.client.attest(
        &h.attester,
        &ref_hash,
        &hash(&h.env, 4),
        &1i128,
        &usdc(&h.env),
        &h.issuer,
        &1u32,
    );

    assert!(h.client.attested(&ref_hash));
}

/// Append-only is the property the whole contract exists to provide: if an
/// attester could overwrite a receipt, a verifier would be trusting them at
/// verification time rather than at attestation time, which is the trust this
/// is meant to remove.
#[test]
fn a_second_attestation_for_the_same_reference_is_rejected() {
    let h = setup();
    let ref_hash = hash(&h.env, 5);

    h.client.attest(
        &h.attester,
        &ref_hash,
        &hash(&h.env, 6),
        &100i128,
        &usdc(&h.env),
        &h.issuer,
        &7u32,
    );

    let err = h
        .client
        .try_attest(
            &h.attester,
            &ref_hash,
            &hash(&h.env, 7),
            &999i128,
            &usdc(&h.env),
            &h.issuer,
            &8u32,
        )
        .expect_err("second attestation must fail");

    assert_eq!(err, Ok(Error::AlreadyAttested));

    // The original survives untouched.
    let receipt = h.client.verify(&ref_hash).expect("still attested");
    assert_eq!(receipt.amount, 100);
    assert_eq!(receipt.ledger, 7);
}

/// A different attester must not be able to displace an existing receipt
/// either — append-only is a property of the reference, not of the caller.
#[test]
fn a_different_attester_cannot_overwrite_an_existing_receipt() {
    let h = setup();
    let ref_hash = hash(&h.env, 10);
    let other = Address::generate(&h.env);

    h.client.attest(
        &h.attester,
        &ref_hash,
        &hash(&h.env, 11),
        &50i128,
        &usdc(&h.env),
        &h.issuer,
        &3u32,
    );

    let err = h
        .client
        .try_attest(
            &other,
            &ref_hash,
            &hash(&h.env, 12),
            &50i128,
            &usdc(&h.env),
            &h.issuer,
            &3u32,
        )
        .expect_err("must not overwrite");
    assert_eq!(err, Ok(Error::AlreadyAttested));

    assert_eq!(h.client.verify(&ref_hash).unwrap().attester, h.attester);
}

#[test]
fn rejects_a_non_positive_amount() {
    let h = setup();

    for amount in [0i128, -1i128] {
        let err = h
            .client
            .try_attest(
                &h.attester,
                &hash(&h.env, 20),
                &hash(&h.env, 21),
                &amount,
                &usdc(&h.env),
                &h.issuer,
                &1u32,
            )
            .expect_err("non-positive amount must fail");
        assert_eq!(err, Ok(Error::InvalidAmount));
    }

    // Nothing was written on the failed paths.
    assert!(!h.client.attested(&hash(&h.env, 20)));
}

/// Distinct references are independent — one settlement never shadows another.
#[test]
fn references_are_stored_independently() {
    let h = setup();

    for seed in 100u8..105 {
        h.client.attest(
            &h.attester,
            &hash(&h.env, seed),
            &hash(&h.env, seed + 50),
            &(i128::from(seed) * 1_000),
            &usdc(&h.env),
            &h.issuer,
            &u32::from(seed),
        );
    }

    for seed in 100u8..105 {
        let receipt = h.client.verify(&hash(&h.env, seed)).expect("attested");
        assert_eq!(receipt.amount, i128::from(seed) * 1_000);
        assert_eq!(receipt.ledger, u32::from(seed));
    }
}

/// The attester's signature is required, so nobody can attest in another
/// party's name. Verified with auth mocking off.
#[test]
#[should_panic]
fn attest_without_the_attesters_authorization_panics() {
    let env = Env::default();
    // Deliberately no mock_all_auths().
    let contract_id = env.register(QuayAttest, ());
    let client = QuayAttestClient::new(&env, &contract_id);
    let attester = Address::generate(&env);
    let issuer = Address::generate(&env);

    client.attest(
        &attester,
        &BytesN::from_array(&env, &[1u8; 32]),
        &BytesN::from_array(&env, &[2u8; 32]),
        &1i128,
        &BytesN::from_array(&env, &[0u8; 12]),
        &issuer,
        &1u32,
    );
}
