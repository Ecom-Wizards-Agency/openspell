use crate::canonical::{FieldValue, object};
use crate::crypto::{
    RecordSigner, SyntheticRecordSigner, sha256_hex, verify_grant, verify_ticket, verify_transition,
};
use crate::journal::storage::{Health, JournalStore, OpenError, StorageError};
use crate::journal::{
    InventoryFiles, JournalError, TransitionFile, VerifiedState, verify_inventory,
};
use crate::protocol::{
    ApproveSuccess, CloseApprovalSuccess, CloseCandidateSuccess, ConsumeSuccess, OPERATOR_APPROVE,
    OPERATOR_APPROVE_SUCCESS, OPERATOR_CLOSE_APPROVAL_SUCCESS, OPERATOR_CLOSE_CANDIDATE_SUCCESS,
    OPERATOR_REFUSAL, OperatorDecode, OperatorRefusal, OperatorRequestFamily, OperatorResponse,
    RefusalCode, RegisterSuccess, SUPERVISOR_CONSUME_SUCCESS, SUPERVISOR_REFUSAL,
    SUPERVISOR_REGISTER_SUCCESS, SUPERVISOR_STATUS, SUPERVISOR_STATUS_SUCCESS, StatusAvailability,
    StatusResponse, SupervisorDecode, SupervisorRefusal, SupervisorRequest,
    SupervisorRequestFamily, SupervisorResponse, decode_operator, decode_supervisor, encode_frame,
    encode_operator_response, encode_supervisor_response,
};
use crate::records::{CANDIDATE_SCHEMA, Candidate, GENESIS_SHA256, Transition};
use crate::state::{
    FreshAttendedAuthentication, RootVerifiedPreparedEnvelope, StateError, approve_candidate,
    close_approval, close_candidate, consume_grant, derive_approval_close_challenge,
    derive_candidate_close_challenge, seal_candidate, sign_approved_transition,
    sign_candidate_registered_transition, sign_consumed_transition,
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
    let mut inventory = InventoryFiles::empty();
    inventory.leaves.insert(
        candidate_sha256.clone(),
        candidate.encode().expect("candidate bytes"),
    );
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
    insert_transition(&mut inventory, &registered, registered_signature);
    let registered_snapshot =
        verify_inventory(&inventory, &public_key).expect("registered inventory");
    assert!(matches!(
        registered_snapshot.state,
        VerifiedState::CandidateRegistered { .. }
    ));
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
    inventory
        .signatures
        .insert(grant_signature_sha256.clone(), grant_signature.to_vec());
    inventory
        .leaves
        .insert(grant_sha256.clone(), grant.encode().expect("grant bytes"));
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
    insert_transition(&mut inventory, &approved, approved_signature);
    let approved_snapshot = verify_inventory(&inventory, &public_key).expect("approved inventory");
    assert!(matches!(
        approved_snapshot.state,
        VerifiedState::Approved { .. }
    ));

    let (ticket, ticket_signature) = consume_grant(
        &candidate,
        &grant,
        &grant_signature,
        "2026-09-03T12:06:00Z",
        [3; 32],
        &signer,
    )
    .expect("ticket");
    let ticket_sha256 = sha256_hex(&ticket.encode().expect("ticket bytes"));
    let ticket_signature_sha256 = sha256_hex(&ticket_signature);
    inventory
        .signatures
        .insert(ticket_signature_sha256.clone(), ticket_signature.to_vec());
    inventory.leaves.insert(
        ticket_sha256.clone(),
        ticket.encode().expect("ticket bytes"),
    );
    let (consumed, consumed_signature) = sign_consumed_transition(
        &candidate,
        candidate_sha256,
        &grant,
        grant_sha256,
        grant_signature_sha256,
        &ticket,
        ticket_sha256,
        ticket_signature_sha256,
        3,
        sha256_hex(&approved_bytes),
        "2026-09-03T12:06:00Z".to_owned(),
        &signer,
    )
    .expect("consumed transition");
    verify_transition(&consumed, &consumed_signature, &public_key).expect("consumed signature");
    let consumed_bytes = consumed.encode().expect("consumed bytes");
    assert_eq!(Transition::decode(&consumed_bytes), Ok(consumed.clone()));
    insert_transition(&mut inventory, &consumed, consumed_signature);
    let consumed_snapshot = verify_inventory(&inventory, &public_key).expect("consumed inventory");
    assert!(matches!(
        consumed_snapshot.state,
        VerifiedState::Consumed { .. }
    ));

    let mut orphaned = inventory.clone();
    let orphan = [99; 64];
    orphaned
        .signatures
        .insert(sha256_hex(&orphan), orphan.to_vec());
    assert_eq!(
        verify_inventory(&orphaned, &public_key),
        Err(JournalError::Unreferenced)
    );

    let mut altered = registered_bytes;
    let field = b"candidate_registered";
    let index = altered
        .windows(field.len())
        .position(|window| window == field)
        .expect("kind field");
    altered[index] = b'x';
    assert!(Transition::decode(&altered).is_err());
}

fn insert_transition(inventory: &mut InventoryFiles, transition: &Transition, signature: [u8; 64]) {
    let bytes = transition.encode().expect("transition bytes");
    inventory
        .signatures
        .insert(sha256_hex(&signature), signature.to_vec());
    inventory.transitions.insert(
        transition.generation(),
        TransitionFile {
            digest: sha256_hex(&bytes),
            bytes,
        },
    );
}

#[test]
fn fd_relative_store_locks_inventories_and_publishes_direct_final_records() {
    use std::fs::{self, File, Permissions};
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let directory = tempfile::tempdir().expect("journal directory");
    let root = directory.path();
    fs::set_permissions(root, Permissions::from_mode(0o700)).expect("root mode");
    fs::create_dir(root.join("objects")).expect("objects");
    fs::create_dir(root.join("objects/leaves")).expect("leaves");
    fs::create_dir(root.join("objects/signatures")).expect("signatures");
    fs::create_dir(root.join("transitions")).expect("transitions");
    for path in [
        root.join("objects"),
        root.join("objects/leaves"),
        root.join("objects/signatures"),
        root.join("transitions"),
    ] {
        fs::set_permissions(path, Permissions::from_mode(0o700)).expect("directory mode");
    }
    fs::write(root.join("FORMAT"), crate::journal::FORMAT_BYTES).expect("format");
    File::create(root.join("LOCK")).expect("lock");
    for path in [root.join("FORMAT"), root.join("LOCK")] {
        fs::set_permissions(path, Permissions::from_mode(0o600)).expect("file mode");
    }
    let metadata = fs::metadata(root).expect("root metadata");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let root_fd: OwnedFd = File::open(root).expect("root fd").into();
    let store = JournalStore::open_from_fd(
        root_fd,
        metadata.uid(),
        metadata.gid(),
        signer.public_key_bytes(),
    )
    .expect("journal store");
    let (health, empty) = store.inspect().expect("empty inventory");
    assert_eq!(health, Health::Available);
    assert!(matches!(empty.state, VerifiedState::Empty));

    let second_fd: OwnedFd = File::open(root).expect("second root fd").into();
    assert_eq!(
        JournalStore::open_from_fd(
            second_fd,
            metadata.uid(),
            metadata.gid(),
            signer.public_key_bytes()
        )
        .err(),
        Some(OpenError::Lock)
    );

    let mut value = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut value, NOW).expect("candidate");
    let candidate_bytes = value.encode().expect("candidate bytes");
    let candidate_sha256 = sha256_hex(&candidate_bytes);
    let (transition, transition_signature) = sign_candidate_registered_transition(
        &value,
        candidate_sha256.clone(),
        1,
        GENESIS_SHA256.to_owned(),
        "empty".to_owned(),
        NOW.to_owned(),
        &signer,
    )
    .expect("transition");
    let transition_bytes = transition.encode().expect("transition bytes");
    let transition_file = TransitionFile {
        digest: sha256_hex(&transition_bytes),
        bytes: transition_bytes,
    };
    let transition_signature_sha256 = sha256_hex(&transition_signature);
    store
        .publish_test_transition(
            &[(&candidate_bytes, &candidate_sha256)],
            &[(&transition_signature, &transition_signature_sha256)],
            &transition_file,
            1,
        )
        .expect("direct-final publication");
    let (_, registered) = store.inspect().expect("registered inventory");
    assert!(matches!(
        registered.state,
        VerifiedState::CandidateRegistered { .. }
    ));
    fs::set_permissions(
        root.join("objects/leaves").join(&candidate_sha256),
        Permissions::from_mode(0o640),
    )
    .expect("corrupt mode");
    assert_eq!(store.inspect(), Err(StorageError::Unavailable));
    assert_eq!(store.inspect(), Err(StorageError::Sealed));
}

#[test]
fn attended_expiry_closures_are_action_bound_and_inventory_verified() {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let mut value = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut value, NOW).expect("candidate");
    let candidate_bytes = value.encode().expect("candidate bytes");
    let candidate_sha256 = sha256_hex(&candidate_bytes);
    let (registered, registered_signature) = sign_candidate_registered_transition(
        &value,
        candidate_sha256.clone(),
        1,
        GENESIS_SHA256.to_owned(),
        "empty".to_owned(),
        NOW.to_owned(),
        &signer,
    )
    .expect("registered");
    let registered_sha256 = sha256_hex(&registered.encode().expect("registered bytes"));

    let mut candidate_inventory = InventoryFiles::empty();
    candidate_inventory
        .leaves
        .insert(candidate_sha256.clone(), candidate_bytes.clone());
    insert_transition(&mut candidate_inventory, &registered, registered_signature);
    let close_candidate_challenge = derive_candidate_close_challenge(
        &registered_sha256,
        &candidate_sha256,
        &value.approval_challenge_sha256,
    )
    .expect("candidate close challenge");
    let close_candidate_auth = FreshAttendedAuthentication::synthetic(
        close_candidate_challenge.clone(),
        digest('e'),
        digest('f'),
        "2026-09-03T12:14:30Z".to_owned(),
    );
    let (candidate_expired, candidate_expired_signature) = close_candidate(
        &value,
        candidate_sha256.clone(),
        2,
        registered_sha256.clone(),
        value.operation_authority_incarnation_sha256.clone(),
        close_candidate_challenge,
        &close_candidate_auth,
        "2026-09-03T12:15:00Z".to_owned(),
        &signer,
    )
    .expect("candidate closure");
    insert_transition(
        &mut candidate_inventory,
        &candidate_expired,
        candidate_expired_signature,
    );
    assert!(matches!(
        verify_inventory(&candidate_inventory, &public_key)
            .expect("candidate closure inventory")
            .state,
        VerifiedState::CandidateExpired { .. }
    ));

    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified");
    let (grant, grant_signature) =
        approve_candidate(&value, &verified, &authentication(&value), NOW, &signer).expect("grant");
    let grant_bytes = grant.encode().expect("grant bytes");
    let grant_sha256 = sha256_hex(&grant_bytes);
    let grant_signature_sha256 = sha256_hex(&grant_signature);
    let (approved, approved_signature) = sign_approved_transition(
        &value,
        candidate_sha256.clone(),
        &grant,
        grant_sha256.clone(),
        grant_signature_sha256.clone(),
        2,
        registered_sha256,
        NOW.to_owned(),
        &signer,
    )
    .expect("approved");
    let approved_sha256 = sha256_hex(&approved.encode().expect("approved bytes"));
    let mut approval_inventory = InventoryFiles::empty();
    approval_inventory
        .leaves
        .insert(candidate_sha256.clone(), candidate_bytes);
    approval_inventory
        .leaves
        .insert(grant_sha256.clone(), grant_bytes);
    approval_inventory
        .signatures
        .insert(grant_signature_sha256.clone(), grant_signature.to_vec());
    insert_transition(&mut approval_inventory, &registered, registered_signature);
    insert_transition(&mut approval_inventory, &approved, approved_signature);
    let close_approval_challenge = derive_approval_close_challenge(
        &approved_sha256,
        &candidate_sha256,
        &value.approval_challenge_sha256,
        &grant_sha256,
        &grant_signature_sha256,
    )
    .expect("approval close challenge");
    assert_ne!(
        close_approval_challenge,
        derive_candidate_close_challenge(
            &approved_sha256,
            &candidate_sha256,
            &value.approval_challenge_sha256
        )
        .expect("other challenge")
    );
    let close_approval_auth = FreshAttendedAuthentication::synthetic(
        close_approval_challenge.clone(),
        digest('e'),
        digest('0'),
        "2026-09-03T12:09:00Z".to_owned(),
    );
    let (approval_expired, approval_expired_signature) = close_approval(
        &value,
        candidate_sha256,
        &grant,
        &grant_signature,
        grant_sha256,
        grant_signature_sha256,
        3,
        approved_sha256,
        value.operation_authority_incarnation_sha256.clone(),
        close_approval_challenge,
        &close_approval_auth,
        "2026-09-03T12:09:30Z".to_owned(),
        &signer,
    )
    .expect("approval closure");
    insert_transition(
        &mut approval_inventory,
        &approval_expired,
        approval_expired_signature,
    );
    assert!(matches!(
        verify_inventory(&approval_inventory, &public_key)
            .expect("approval closure inventory")
            .state,
        VerifiedState::ApprovalExpired { .. }
    ));
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
        SupervisorDecode::Request(SupervisorRequest::Status(_))
    ));
    assert!(matches!(
        decode_operator(&frame),
        OperatorDecode::Unclassified
    ));

    let wrong_surface = encode_frame(OPERATOR_APPROVE, &payload).expect("operator frame");
    assert!(matches!(
        decode_supervisor(&wrong_surface),
        SupervisorDecode::Unclassified
    ));
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
        assert!(matches!(
            decode_supervisor(&changed),
            SupervisorDecode::Unclassified
        ));
    }

    let noncanonical = String::from_utf8(payload).expect("utf8").replace(": ", ":");
    let frame = encode_frame(SUPERVISOR_STATUS, noncanonical.as_bytes()).expect("frame");
    assert!(matches!(
        decode_supervisor(&frame),
        SupervisorDecode::Malformed(SupervisorRequestFamily::Status)
    ));
}

#[test]
fn every_response_family_has_a_fixed_surface_opcode_and_canonical_shape() {
    let transition = digest('1');
    let register = encode_supervisor_response(SupervisorResponse::Register(RegisterSuccess {
        generation: 1,
        transition_sha256: transition.clone(),
        candidate_sha256: digest('2'),
        candidate_binding_sha256: digest('3'),
        approval_challenge_sha256: digest('4'),
        cutoff_at: "2026-09-03T12:15:00.000Z".to_owned(),
    }))
    .expect("register response");
    assert_frame_type(register.as_bytes(), SUPERVISOR_REGISTER_SUCCESS);
    assert!(frame_text(register.as_bytes()).starts_with(
        "{\n  \"schemaVersion\": \"openspell.hosted-migration-root-register-success.v1\",\n  \"status\": \"committed\",\n"
    ));

    let statuses = [
        StatusResponse::Absent,
        StatusResponse::Candidate {
            status: StatusAvailability::RecoveryOnly,
            generation: 1,
            transition_sha256: transition.clone(),
            candidate_sha256: digest('2'),
            candidate_binding_sha256: digest('3'),
            approval_challenge_sha256: digest('4'),
            cutoff_at: "2026-09-03T12:15:00Z".to_owned(),
        },
        StatusResponse::Approved {
            status: StatusAvailability::Available,
            generation: 2,
            transition_sha256: transition.clone(),
            approval_grant_sha256: digest('5'),
            approval_grant_signature_sha256: digest('6'),
            expires_at: "2026-09-03T12:15:00Z".to_owned(),
        },
        StatusResponse::Consumed {
            status: StatusAvailability::Available,
            generation: 3,
            transition_sha256: transition.clone(),
            execution_ticket_sha256: digest('7'),
            execution_ticket_signature_sha256: digest('8'),
            expires_at: "2026-09-03T12:15:00.000Z".to_owned(),
        },
        StatusResponse::CandidateExpired {
            status: StatusAvailability::Available,
            generation: 2,
            transition_sha256: transition.clone(),
            candidate_sha256: digest('2'),
        },
        StatusResponse::ApprovalExpired {
            status: StatusAvailability::Available,
            generation: 3,
            transition_sha256: transition.clone(),
            approval_grant_sha256: digest('5'),
            approval_grant_signature_sha256: digest('6'),
        },
    ];
    for status in statuses {
        let frame = encode_supervisor_response(SupervisorResponse::Status(status))
            .expect("status response");
        assert_frame_type(frame.as_bytes(), SUPERVISOR_STATUS_SUCCESS);
        assert!(!frame_text(frame.as_bytes()).contains("operationId"));
        assert!(!frame_text(frame.as_bytes()).contains("RawSignature"));
    }

    let supervisor_refusal =
        encode_supervisor_response(SupervisorResponse::Refusal(SupervisorRefusal {
            family: SupervisorRequestFamily::ConsumeGrant,
            code: RefusalCode::JournalUnavailable,
        }))
        .expect("supervisor refusal");
    assert_frame_type(supervisor_refusal.as_bytes(), SUPERVISOR_REFUSAL);
    assert_eq!(
        frame_text(supervisor_refusal.as_bytes()),
        "{\n  \"schemaVersion\": \"openspell.hosted-migration-root-supervisor-refusal.v1\",\n  \"requestFamily\": \"consume_grant\",\n  \"status\": \"refused\",\n  \"code\": \"journal_unavailable\"\n}\n"
    );

    let approve = encode_operator_response(OperatorResponse::Approve(ApproveSuccess {
        generation: 2,
        transition_sha256: transition.clone(),
        approval_grant_sha256: digest('5'),
        approval_grant_signature_sha256: digest('6'),
        expires_at: "2026-09-03T12:15:00Z".to_owned(),
    }))
    .expect("approve response");
    assert_frame_type(approve.as_bytes(), OPERATOR_APPROVE_SUCCESS);
    let close_candidate =
        encode_operator_response(OperatorResponse::CloseCandidate(CloseCandidateSuccess {
            generation: 2,
            transition_sha256: transition.clone(),
        }))
        .expect("candidate close response");
    assert_frame_type(close_candidate.as_bytes(), OPERATOR_CLOSE_CANDIDATE_SUCCESS);
    let close_approval =
        encode_operator_response(OperatorResponse::CloseApproval(CloseApprovalSuccess {
            generation: 3,
            transition_sha256: transition,
        }))
        .expect("approval close response");
    assert_frame_type(close_approval.as_bytes(), OPERATOR_CLOSE_APPROVAL_SUCCESS);
    let operator_refusal = encode_operator_response(OperatorResponse::Refusal(OperatorRefusal {
        family: OperatorRequestFamily::CloseExpiredApproval,
        code: RefusalCode::NotExpired,
    }))
    .expect("operator refusal");
    assert_frame_type(operator_refusal.as_bytes(), OPERATOR_REFUSAL);
}

#[test]
fn consume_response_is_the_only_bearer_and_fits_one_record() {
    let mut value = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut value, NOW).expect("candidate");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified");
    let (grant, grant_signature) =
        approve_candidate(&value, &verified, &authentication(&value), NOW, &signer).expect("grant");
    let (ticket, ticket_signature) = consume_grant(
        &value,
        &grant,
        &grant_signature,
        "2026-09-03T12:06:00Z",
        [3; 32],
        &signer,
    )
    .expect("ticket");
    let frame = encode_supervisor_response(SupervisorResponse::Consume(ConsumeSuccess {
        generation: 3,
        transition_sha256: digest('1'),
        execution_ticket_canonical_hex: hex::encode(ticket.encode().expect("ticket bytes")),
        execution_ticket_raw_signature_hex: hex::encode(ticket_signature),
    }))
    .expect("consume response");
    assert_frame_type(frame.as_bytes(), SUPERVISOR_CONSUME_SUCCESS);
    assert!(frame.as_bytes().len() <= crate::protocol::MAX_FRAME_BYTES);
    assert!(frame_text(frame.as_bytes()).contains("executionTicketCanonicalHex"));
    assert!(frame_text(frame.as_bytes()).contains("executionTicketRawSignatureHex"));
}

fn assert_frame_type(frame: &[u8], expected: u16) {
    assert_eq!(u16::from_be_bytes([frame[10], frame[11]]), expected);
}

fn frame_text(frame: &[u8]) -> &str {
    std::str::from_utf8(&frame[crate::protocol::FRAME_HEADER_BYTES..]).expect("frame payload")
}
