use crate::canonical::{FieldValue, object};
use crate::crypto::{
    RecordSigner, SyntheticRecordSigner, sha256_hex, verify_grant, verify_ticket, verify_transition,
};
use crate::protocol::{
    OPERATOR_APPROVE, ProtocolError, SUPERVISOR_STATUS, SupervisorRequest, decode_operator,
    decode_supervisor, encode_frame,
};
use crate::records::{CANDIDATE_SCHEMA, Candidate, GENESIS_SHA256, Transition};
use crate::state::{
    FreshAttendedAuthentication, RootVerifiedPreparedEnvelope, StateError, approve_candidate,
    consume_grant, seal_candidate, sign_approved_transition, sign_candidate_registered_transition,
    sign_consumed_transition,
};

const NOW: &str = "2026-09-03T12:05:00Z";

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

fn candidate(envelope_expiry: &str) -> Candidate {
    Candidate {
        schema_version: CANDIDATE_SCHEMA.to_owned(),
        operation_id: digest('1'),
        authorization_nonce: digest('2'),
        target_fingerprint: digest('3'),
        target_selection_sha256: digest('4'),
        envelope_sha256: digest('5'),
        envelope_expires_at: envelope_expiry.to_owned(),
        external_exclusive_window_generation: 7,
        external_exclusive_window_evidence_sha256: digest('6'),
        external_exclusive_window_expires_at: "2026-09-03T12:15:00.000Z".to_owned(),
        official_source_evidence_sha256: digest('7'),
        native_runtime_identity_sha256: digest('8'),
        child_sandbox_policy_sha256: digest('9'),
        phase_exec_topology_policy_sha256: digest('a'),
        child_cgroup_policy_sha256: digest('b'),
        apply_invocation_evidence_sha256: digest('c'),
        operation_authority_incarnation_sha256: digest('d'),
        candidate_binding_sha256: String::new(),
        approval_challenge_sha256: String::new(),
        stored_at: String::new(),
        cutoff_at: String::new(),
    }
}

fn observations() -> [&'static str; 4] {
    [
        "2026-09-03T12:04:01.000Z",
        "2026-09-03T12:04:01Z",
        "2026-09-03T12:04:01Z",
        "2026-09-03T12:04:01Z",
    ]
}

fn authentication(candidate: &Candidate) -> FreshAttendedAuthentication {
    FreshAttendedAuthentication::synthetic(
        candidate.approval_challenge_sha256.clone(),
        digest('e'),
        digest('f'),
        "2026-09-03T12:04:30Z".to_owned(),
    )
}

#[test]
fn candidate_binding_is_acyclic_and_uses_equal_instant_precedence() {
    let mut value = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut value, NOW).expect("candidate");
    assert_eq!(value.cutoff_at, "2026-09-03T12:15:00Z");
    assert_eq!(value.candidate_binding_sha256.len(), 64);
    assert_eq!(value.approval_challenge_sha256.len(), 64);
    let original_binding = value.candidate_binding_sha256.clone();

    let mut changed = candidate("2026-09-03T12:15:00Z");
    changed.target_selection_sha256 = digest('0');
    seal_candidate(&mut changed, NOW).expect("changed candidate");
    assert_ne!(changed.candidate_binding_sha256, original_binding);

    let bytes = value.encode().expect("canonical candidate");
    assert_eq!(Candidate::decode(&bytes), Ok(value));
}

#[test]
fn registration_accepts_900_seconds_and_refuses_901() {
    let mut exact = candidate("2026-09-03T12:20:00Z");
    seal_candidate(&mut exact, NOW).expect("900 second candidate");
    let mut too_far = candidate("2026-09-03T12:20:01Z");
    assert_eq!(seal_candidate(&mut too_far, NOW), Err(StateError::Expired));
}

#[test]
fn grant_and_ticket_are_exactly_signed_and_cross_bound() {
    let mut candidate = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut candidate, NOW).expect("candidate");
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&candidate, observations()).expect("verified");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let auth = authentication(&candidate);
    let (grant, grant_signature) =
        approve_candidate(&candidate, &verified, &auth, NOW, &signer).expect("grant");
    assert_eq!(grant.expires_at, "2026-09-03T12:09:30Z");
    assert_eq!(
        grant.detached_signature_sha256,
        sha256_hex(&grant_signature)
    );
    verify_grant(&grant, &grant_signature, &signer.public_key_bytes()).expect("grant signature");

    let (ticket, ticket_signature) = consume_grant(
        &candidate,
        &grant,
        &grant_signature,
        "2026-09-03T12:06:00Z",
        [3; 32],
        &signer,
    )
    .expect("ticket");
    assert_eq!(ticket.expires_at, grant.expires_at);
    assert_eq!(
        ticket.approval_grant_sha256,
        sha256_hex(&grant.encode().expect("grant bytes"))
    );
    verify_ticket(&ticket, &ticket_signature, &signer.public_key_bytes())
        .expect("ticket signature");
}

#[test]
fn transition_chain_records_are_canonical_signed_and_hash_bound() {
    let mut candidate = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut candidate, NOW).expect("candidate");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let candidate_sha256 = sha256_hex(&candidate.encode().expect("candidate bytes"));
    let (registered, registered_signature) = sign_candidate_registered_transition(
        &candidate,
        candidate_sha256.clone(),
        1,
        GENESIS_SHA256.to_owned(),
        "empty".to_owned(),
        NOW.to_owned(),
        &signer,
    )
    .expect("registered transition");
    verify_transition(&registered, &registered_signature, &public_key)
        .expect("registered signature");
    let registered_bytes = registered.encode().expect("registered bytes");
    assert_eq!(
        Transition::decode(&registered_bytes),
        Ok(registered.clone())
    );

    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&candidate, observations()).expect("verified");
    let (grant, grant_signature) = approve_candidate(
        &candidate,
        &verified,
        &authentication(&candidate),
        NOW,
        &signer,
    )
    .expect("grant");
    let grant_sha256 = sha256_hex(&grant.encode().expect("grant bytes"));
    let grant_signature_sha256 = sha256_hex(&grant_signature);
    let (approved, approved_signature) = sign_approved_transition(
        &candidate,
        candidate_sha256.clone(),
        &grant,
        grant_sha256.clone(),
        grant_signature_sha256.clone(),
        2,
        sha256_hex(&registered_bytes),
        NOW.to_owned(),
        &signer,
    )
    .expect("approved transition");
    verify_transition(&approved, &approved_signature, &public_key).expect("approved signature");
    let approved_bytes = approved.encode().expect("approved bytes");

    let (ticket, ticket_signature) = consume_grant(
        &candidate,
        &grant,
        &grant_signature,
        "2026-09-03T12:06:00Z",
        [3; 32],
        &signer,
    )
    .expect("ticket");
    let (consumed, consumed_signature) = sign_consumed_transition(
        &candidate,
        candidate_sha256,
        &grant,
        grant_sha256,
        grant_signature_sha256,
        &ticket,
        sha256_hex(&ticket.encode().expect("ticket bytes")),
        sha256_hex(&ticket_signature),
        3,
        sha256_hex(&approved_bytes),
        "2026-09-03T12:06:00Z".to_owned(),
        &signer,
    )
    .expect("consumed transition");
    verify_transition(&consumed, &consumed_signature, &public_key).expect("consumed signature");
    let consumed_bytes = consumed.encode().expect("consumed bytes");
    assert_eq!(Transition::decode(&consumed_bytes), Ok(consumed));

    let mut altered = registered_bytes;
    let field = b"candidate_registered";
    let index = altered
        .windows(field.len())
        .position(|window| window == field)
        .expect("kind field");
    altered[index] = b'x';
    assert!(Transition::decode(&altered).is_err());
}

#[test]
fn each_verified_observation_has_an_independent_strict_sixty_second_gate() {
    let mut candidate = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut candidate, NOW).expect("candidate");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);

    for index in 0..4 {
        let mut fresh = [
            "2026-09-03T12:04:59.000Z",
            "2026-09-03T12:04:59Z",
            "2026-09-03T12:04:59Z",
            "2026-09-03T12:04:59Z",
        ];
        fresh[index] = if index == 0 {
            "2026-09-03T12:04:01.000Z"
        } else {
            "2026-09-03T12:04:01Z"
        };
        let verified =
            RootVerifiedPreparedEnvelope::synthetic(&candidate, fresh).expect("fresh capability");
        assert!(
            approve_candidate(
                &candidate,
                &verified,
                &authentication(&candidate),
                NOW,
                &signer
            )
            .is_ok()
        );

        let mut stale = fresh;
        stale[index] = if index == 0 {
            "2026-09-03T12:04:00.000Z"
        } else {
            "2026-09-03T12:04:00Z"
        };
        let verified =
            RootVerifiedPreparedEnvelope::synthetic(&candidate, stale).expect("stale capability");
        assert_eq!(
            approve_candidate(
                &candidate,
                &verified,
                &authentication(&candidate),
                NOW,
                &signer
            ),
            Err(StateError::Stale)
        );

        let mut future = fresh;
        future[index] = if index == 0 {
            "2026-09-03T12:05:01.000Z"
        } else {
            "2026-09-03T12:05:01Z"
        };
        let verified =
            RootVerifiedPreparedEnvelope::synthetic(&candidate, future).expect("future capability");
        assert_eq!(
            approve_candidate(
                &candidate,
                &verified,
                &authentication(&candidate),
                NOW,
                &signer
            ),
            Err(StateError::Future)
        );
    }
}

#[test]
fn exact_decoders_refuse_reordered_or_extended_records() {
    let mut candidate = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut candidate, NOW).expect("candidate");
    let canonical = String::from_utf8(candidate.encode().expect("candidate bytes")).expect("utf8");
    let extended = canonical.replacen(
        "  \"operationId\":",
        "  \"unexpected\": \"value\",\n  \"operationId\":",
        1,
    );
    assert!(Candidate::decode(extended.as_bytes()).is_err());
}

#[test]
fn package_frame_version_is_pinned() {
    assert_eq!(super::protocol::FRAME_VERSION, 1);
}

#[test]
fn supervisor_and_operator_decoders_are_nonmultiplexed() {
    let payload = object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-status-request.v1"),
        ),
        ("operationId", FieldValue::String(&digest('1'))),
    ])
    .expect("payload");
    let frame = encode_frame(SUPERVISOR_STATUS, &payload).expect("frame");
    assert!(matches!(
        decode_supervisor(&frame),
        Ok(SupervisorRequest::Status(_))
    ));
    assert_eq!(decode_operator(&frame), Err(ProtocolError::MessageType));

    let wrong_surface = encode_frame(OPERATOR_APPROVE, &payload).expect("operator frame");
    assert_eq!(
        decode_supervisor(&wrong_surface),
        Err(ProtocolError::MessageType)
    );
}

#[test]
fn frame_hash_length_version_and_payload_canonicality_are_exact() {
    let payload = object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-status-request.v1"),
        ),
        ("operationId", FieldValue::String(&digest('1'))),
    ])
    .expect("payload");
    let frame = encode_frame(SUPERVISOR_STATUS, &payload).expect("frame");

    for index in [0, 9, 15, 16, frame.len() - 1] {
        let mut changed = frame.clone();
        changed[index] ^= 1;
        assert!(decode_supervisor(&changed).is_err());
    }

    let noncanonical = String::from_utf8(payload).expect("utf8").replace(": ", ":");
    let frame = encode_frame(SUPERVISOR_STATUS, noncanonical.as_bytes()).expect("frame");
    assert_eq!(decode_supervisor(&frame), Err(ProtocolError::Payload));
}
