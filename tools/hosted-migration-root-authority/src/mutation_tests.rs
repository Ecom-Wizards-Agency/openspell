use ed25519_dalek::Signer as _;

use crate::crypto::{
    CryptoError, RecordSigner, SyntheticRecordSigner, sha256_hex, verify_grant, verify_ticket,
    verify_transition,
};
use crate::journal::{InventoryFiles, JournalError, TransitionFile, verify_inventory};
use crate::records::{
    ApprovalExpiredTransition, ApprovalGrant, ApprovedTransition, CANDIDATE_SCHEMA, Candidate,
    CandidateExpiredTransition, CandidateRegisteredTransition, ConsumedTransition, ExecutionTicket,
    GENESIS_SHA256, GRANT_DOMAIN, TICKET_DOMAIN, Transition,
};
use crate::state::{
    FreshAttendedAuthentication, RootVerifiedPreparedEnvelope, approve_candidate, close_approval,
    close_candidate, consume_grant, derive_approval_close_challenge,
    derive_candidate_close_challenge, seal_candidate, sign_approved_transition,
    sign_candidate_registered_transition, sign_consumed_transition,
};

const NOW: &str = "2026-09-03T12:05:00Z";
const CONSUMED_AT: &str = "2026-09-03T12:06:00Z";

type FieldMutation<T> = (&'static str, fn(&mut T));

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

fn change_digest(value: &mut String) {
    *value = if value == &digest('0') {
        digest('1')
    } else {
        digest('0')
    };
}

fn change_text(value: &mut String) {
    value.push_str("_changed");
}

fn candidate() -> Candidate {
    Candidate {
        schema_version: CANDIDATE_SCHEMA.to_owned(),
        operation_id: digest('1'),
        authorization_nonce: digest('2'),
        target_fingerprint: digest('3'),
        target_selection_sha256: digest('4'),
        envelope_sha256: digest('5'),
        envelope_expires_at: "2026-09-03T12:15:00Z".to_owned(),
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

fn set_transition_signature_digest(transition: &mut Transition, value: String) {
    match transition {
        Transition::CandidateRegistered(record) => record.detached_signature_sha256 = value,
        Transition::Approved(record) => record.detached_signature_sha256 = value,
        Transition::Consumed(record) => record.detached_signature_sha256 = value,
        Transition::CandidateExpired(record) => record.detached_signature_sha256 = value,
        Transition::ApprovalExpired(record) => record.detached_signature_sha256 = value,
    }
}

fn change_transition_issuer_digest(transition: &mut Transition) {
    match transition {
        Transition::CandidateRegistered(record) => {
            change_digest(&mut record.issuer_public_key_sha256)
        }
        Transition::Approved(record) => change_digest(&mut record.issuer_public_key_sha256),
        Transition::Consumed(record) => change_digest(&mut record.issuer_public_key_sha256),
        Transition::CandidateExpired(record) => change_digest(&mut record.issuer_public_key_sha256),
        Transition::ApprovalExpired(record) => change_digest(&mut record.issuer_public_key_sha256),
    }
}

fn resign_transition(
    mut transition: Transition,
    signer: &SyntheticRecordSigner,
) -> (Transition, [u8; 64]) {
    let signature = match &transition {
        Transition::CandidateRegistered(record) => signer
            .sign_candidate_registered_transition(record)
            .expect("candidate registration signature"),
        Transition::Approved(record) => signer
            .sign_approved_transition(record)
            .expect("approval transition signature"),
        Transition::Consumed(record) => signer
            .sign_consumed_transition(record)
            .expect("consume transition signature"),
        Transition::CandidateExpired(record) => signer
            .sign_candidate_expired_transition(record)
            .expect("candidate closure signature"),
        Transition::ApprovalExpired(record) => signer
            .sign_approval_expired_transition(record)
            .expect("approval closure signature"),
    };
    set_transition_signature_digest(&mut transition, sha256_hex(&signature));
    verify_transition(&transition, &signature, &signer.public_key_bytes())
        .expect("re-signed transition is cryptographically valid");
    (transition, signature)
}

fn assemble_inventory(
    leaves: Vec<Vec<u8>>,
    detached_signatures: Vec<[u8; 64]>,
    transitions: Vec<(Transition, [u8; 64])>,
) -> InventoryFiles {
    let mut inventory = InventoryFiles::empty();
    for leaf in leaves {
        inventory.leaves.insert(sha256_hex(&leaf), leaf);
    }
    for signature in detached_signatures {
        inventory
            .signatures
            .insert(sha256_hex(&signature), signature.to_vec());
    }
    for (transition, signature) in transitions {
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
    inventory
}

struct Fixture {
    signer: SyntheticRecordSigner,
    public_key: [u8; 32],
    candidate: Candidate,
    candidate_bytes: Vec<u8>,
    candidate_sha256: String,
    grant: ApprovalGrant,
    grant_signature: [u8; 64],
    ticket: ExecutionTicket,
    ticket_signature: [u8; 64],
    registered: Transition,
    registered_signature: [u8; 64],
    approved: Transition,
    approved_signature: [u8; 64],
    consumed: Transition,
    consumed_signature: [u8; 64],
    candidate_expired: Transition,
    candidate_expired_signature: [u8; 64],
    approval_expired: Transition,
    approval_expired_signature: [u8; 64],
}

impl Fixture {
    fn new() -> Self {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let mut candidate = candidate();
        seal_candidate(&mut candidate, NOW).expect("sealed candidate");
        let candidate_bytes = candidate.encode().expect("candidate bytes");
        let candidate_sha256 = sha256_hex(&candidate_bytes);
        let verified = RootVerifiedPreparedEnvelope::synthetic(
            &candidate,
            [
                "2026-09-03T12:04:01.000Z",
                "2026-09-03T12:04:01Z",
                "2026-09-03T12:04:01Z",
                "2026-09-03T12:04:01Z",
            ],
        )
        .expect("verified observations");
        let approval_authentication = FreshAttendedAuthentication::synthetic(
            candidate.approval_challenge_sha256.clone(),
            digest('e'),
            digest('f'),
            "2026-09-03T12:04:30Z".to_owned(),
        );
        let (grant, grant_signature) = approve_candidate(
            &candidate,
            &verified,
            &approval_authentication,
            NOW,
            &signer,
        )
        .expect("approval grant");
        let (ticket, ticket_signature) = consume_grant(
            &candidate,
            &grant,
            &grant_signature,
            CONSUMED_AT,
            [3; 32],
            &signer,
        )
        .expect("execution ticket");
        let (registered, registered_signature) = sign_candidate_registered_transition(
            &candidate,
            candidate_sha256.clone(),
            1,
            GENESIS_SHA256.to_owned(),
            "empty".to_owned(),
            NOW.to_owned(),
            &signer,
        )
        .expect("candidate registration");
        let registered_sha256 = sha256_hex(&registered.encode().expect("registered bytes"));
        let grant_bytes = grant.encode().expect("grant bytes");
        let grant_sha256 = sha256_hex(&grant_bytes);
        let grant_signature_sha256 = sha256_hex(&grant_signature);
        let (approved, approved_signature) = sign_approved_transition(
            &candidate,
            candidate_sha256.clone(),
            &grant,
            grant_sha256.clone(),
            grant_signature_sha256.clone(),
            2,
            registered_sha256.clone(),
            NOW.to_owned(),
            &signer,
        )
        .expect("approval transition");
        let approved_sha256 = sha256_hex(&approved.encode().expect("approved bytes"));
        let ticket_bytes = ticket.encode().expect("ticket bytes");
        let ticket_sha256 = sha256_hex(&ticket_bytes);
        let ticket_signature_sha256 = sha256_hex(&ticket_signature);
        let (consumed, consumed_signature) = sign_consumed_transition(
            &candidate,
            candidate_sha256.clone(),
            &grant,
            grant_sha256.clone(),
            grant_signature_sha256.clone(),
            &ticket,
            ticket_sha256,
            ticket_signature_sha256,
            3,
            approved_sha256.clone(),
            CONSUMED_AT.to_owned(),
            &signer,
        )
        .expect("consume transition");

        let candidate_close_challenge = derive_candidate_close_challenge(
            &registered_sha256,
            &candidate_sha256,
            &candidate.approval_challenge_sha256,
        )
        .expect("candidate close challenge");
        let candidate_close_authentication = FreshAttendedAuthentication::synthetic(
            candidate_close_challenge.clone(),
            digest('e'),
            digest('0'),
            "2026-09-03T12:14:30Z".to_owned(),
        );
        let (candidate_expired, candidate_expired_signature) = close_candidate(
            &candidate,
            candidate_sha256.clone(),
            2,
            registered_sha256,
            digest('e'),
            candidate_close_challenge,
            &candidate_close_authentication,
            "2026-09-03T12:15:00Z".to_owned(),
            &signer,
        )
        .expect("candidate closure");

        let approval_close_challenge = derive_approval_close_challenge(
            &approved_sha256,
            &candidate_sha256,
            &candidate.approval_challenge_sha256,
            &grant_sha256,
            &grant_signature_sha256,
        )
        .expect("approval close challenge");
        let approval_close_authentication = FreshAttendedAuthentication::synthetic(
            approval_close_challenge.clone(),
            digest('e'),
            digest('0'),
            "2026-09-03T12:09:00Z".to_owned(),
        );
        let (approval_expired, approval_expired_signature) = close_approval(
            &candidate,
            candidate_sha256.clone(),
            &grant,
            &grant_signature,
            grant_sha256,
            grant_signature_sha256,
            3,
            approved_sha256,
            digest('e'),
            approval_close_challenge,
            &approval_close_authentication,
            "2026-09-03T12:09:30Z".to_owned(),
            &signer,
        )
        .expect("approval closure");

        Self {
            signer,
            public_key,
            candidate,
            candidate_bytes,
            candidate_sha256,
            grant,
            grant_signature,
            ticket,
            ticket_signature,
            registered,
            registered_signature,
            approved,
            approved_signature,
            consumed,
            consumed_signature,
            candidate_expired,
            candidate_expired_signature,
            approval_expired,
            approval_expired_signature,
        }
    }

    fn registered_inventory(&self, registered: Transition, signature: [u8; 64]) -> InventoryFiles {
        assemble_inventory(
            vec![self.candidate_bytes.clone()],
            vec![],
            vec![(registered, signature)],
        )
    }

    fn approved_inventory(
        &self,
        grant: ApprovalGrant,
        grant_signature: [u8; 64],
        approved: Transition,
        approved_signature: [u8; 64],
    ) -> InventoryFiles {
        assemble_inventory(
            vec![
                self.candidate_bytes.clone(),
                grant.encode().expect("grant bytes"),
            ],
            vec![grant_signature],
            vec![
                (self.registered.clone(), self.registered_signature),
                (approved, approved_signature),
            ],
        )
    }

    fn consumed_inventory(
        &self,
        ticket: ExecutionTicket,
        ticket_signature: [u8; 64],
        consumed: Transition,
        consumed_signature: [u8; 64],
    ) -> InventoryFiles {
        assemble_inventory(
            vec![
                self.candidate_bytes.clone(),
                self.grant.encode().expect("grant bytes"),
                ticket.encode().expect("ticket bytes"),
            ],
            vec![self.grant_signature, ticket_signature],
            vec![
                (self.registered.clone(), self.registered_signature),
                (self.approved.clone(), self.approved_signature),
                (consumed, consumed_signature),
            ],
        )
    }
}

fn assert_field_mutations<T: Clone>(
    original: &T,
    signature: &[u8; 64],
    key: &[u8; 32],
    encode: impl Fn(&T) -> Vec<u8>,
    verify: impl Fn(&T, &[u8; 64], &[u8; 32]) -> Result<(), CryptoError>,
    mutations: &[FieldMutation<T>],
) {
    let original_bytes = encode(original);
    for (name, mutate) in mutations {
        let mut changed = original.clone();
        mutate(&mut changed);
        assert_ne!(
            encode(&changed),
            original_bytes,
            "{name} did not change bytes"
        );
        assert!(
            verify(&changed, signature, key).is_err(),
            "mutation of {name} retained signature validity"
        );
    }
}

#[test]
fn every_approval_grant_and_execution_ticket_field_is_exactly_bound() {
    let fixture = Fixture::new();
    let grant_mutations: &[FieldMutation<ApprovalGrant>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("target_fingerprint", |v| {
            change_digest(&mut v.target_fingerprint)
        }),
        ("target_selection_sha256", |v| {
            change_digest(&mut v.target_selection_sha256)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("external_exclusive_window_generation", |v| {
            v.external_exclusive_window_generation += 1
        }),
        ("external_exclusive_window_evidence_sha256", |v| {
            change_digest(&mut v.external_exclusive_window_evidence_sha256)
        }),
        ("official_source_evidence_sha256", |v| {
            change_digest(&mut v.official_source_evidence_sha256)
        }),
        ("native_runtime_identity_sha256", |v| {
            change_digest(&mut v.native_runtime_identity_sha256)
        }),
        ("child_sandbox_policy_sha256", |v| {
            change_digest(&mut v.child_sandbox_policy_sha256)
        }),
        ("phase_exec_topology_policy_sha256", |v| {
            change_digest(&mut v.phase_exec_topology_policy_sha256)
        }),
        ("child_cgroup_policy_sha256", |v| {
            change_digest(&mut v.child_cgroup_policy_sha256)
        }),
        ("apply_invocation_evidence_sha256", |v| {
            change_digest(&mut v.apply_invocation_evidence_sha256)
        }),
        ("issued_at", |v| {
            v.issued_at = "2026-09-03T12:05:01Z".to_owned()
        }),
        ("expires_at", |v| {
            v.expires_at = "2026-09-03T12:09:29Z".to_owned()
        }),
        ("authenticated_operator_identity_sha256", |v| {
            change_digest(&mut v.authenticated_operator_identity_sha256)
        }),
        ("os_authentication_session_sha256", |v| {
            change_digest(&mut v.os_authentication_session_sha256)
        }),
        ("authenticated_at", |v| {
            v.authenticated_at = "2026-09-03T12:04:29Z".to_owned()
        }),
        ("state", |v| change_text(&mut v.state)),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_field_mutations(
        &fixture.grant,
        &fixture.grant_signature,
        &fixture.public_key,
        |value| value.encode().expect("grant encoding"),
        verify_grant,
        grant_mutations,
    );

    let ticket_mutations: &[FieldMutation<ExecutionTicket>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("approval_grant_sha256", |v| {
            change_digest(&mut v.approval_grant_sha256)
        }),
        ("approval_grant_signature_sha256", |v| {
            change_digest(&mut v.approval_grant_signature_sha256)
        }),
        ("ticket_nonce", |v| change_digest(&mut v.ticket_nonce)),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("target_fingerprint", |v| {
            change_digest(&mut v.target_fingerprint)
        }),
        ("target_selection_sha256", |v| {
            change_digest(&mut v.target_selection_sha256)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("external_exclusive_window_generation", |v| {
            v.external_exclusive_window_generation += 1
        }),
        ("external_exclusive_window_evidence_sha256", |v| {
            change_digest(&mut v.external_exclusive_window_evidence_sha256)
        }),
        ("official_source_evidence_sha256", |v| {
            change_digest(&mut v.official_source_evidence_sha256)
        }),
        ("native_runtime_identity_sha256", |v| {
            change_digest(&mut v.native_runtime_identity_sha256)
        }),
        ("child_sandbox_policy_sha256", |v| {
            change_digest(&mut v.child_sandbox_policy_sha256)
        }),
        ("phase_exec_topology_policy_sha256", |v| {
            change_digest(&mut v.phase_exec_topology_policy_sha256)
        }),
        ("child_cgroup_policy_sha256", |v| {
            change_digest(&mut v.child_cgroup_policy_sha256)
        }),
        ("apply_invocation_evidence_sha256", |v| {
            change_digest(&mut v.apply_invocation_evidence_sha256)
        }),
        ("consumed_at", |v| {
            v.consumed_at = "2026-09-03T12:06:01Z".to_owned()
        }),
        ("expires_at", |v| {
            v.expires_at = "2026-09-03T12:09:29Z".to_owned()
        }),
        ("state", |v| change_text(&mut v.state)),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_field_mutations(
        &fixture.ticket,
        &fixture.ticket_signature,
        &fixture.public_key,
        |value| value.encode().expect("ticket encoding"),
        verify_ticket,
        ticket_mutations,
    );
}

fn assert_transition_mutations<T: Clone>(
    original: &T,
    signature: &[u8; 64],
    key: &[u8; 32],
    wrap: impl Fn(T) -> Transition,
    mutations: &[FieldMutation<T>],
) {
    let original_transition = wrap(original.clone());
    let original_bytes = original_transition.encode().expect("transition encoding");
    for (name, mutate) in mutations {
        let mut changed = original.clone();
        mutate(&mut changed);
        let changed_transition = wrap(changed);
        assert_ne!(
            changed_transition
                .encode()
                .expect("changed transition encoding"),
            original_bytes,
            "{name} did not change bytes"
        );
        assert!(
            verify_transition(&changed_transition, signature, key).is_err(),
            "mutation of {name} retained signature validity"
        );
    }
}

#[test]
fn every_candidate_registered_transition_field_is_exactly_bound() {
    let fixture = Fixture::new();
    let Transition::CandidateRegistered(record) = &fixture.registered else {
        panic!("registered fixture kind");
    };
    let mutations: &[FieldMutation<CandidateRegisteredTransition>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("generation", |v| v.generation += 1),
        ("previous_transition_sha256", |v| {
            change_digest(&mut v.previous_transition_sha256)
        }),
        ("transition_kind", |v| change_text(&mut v.transition_kind)),
        ("prior_state", |v| change_text(&mut v.prior_state)),
        ("resulting_state", |v| change_text(&mut v.resulting_state)),
        ("candidate_sha256", |v| {
            change_digest(&mut v.candidate_sha256)
        }),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("operation_authority_incarnation_sha256", |v| {
            change_digest(&mut v.operation_authority_incarnation_sha256)
        }),
        ("candidate_binding_sha256", |v| {
            change_digest(&mut v.candidate_binding_sha256)
        }),
        ("approval_challenge_sha256", |v| {
            change_digest(&mut v.approval_challenge_sha256)
        }),
        ("trusted_at", |v| {
            v.trusted_at = "2026-09-03T12:05:01Z".to_owned()
        }),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_transition_mutations(
        record,
        &fixture.registered_signature,
        &fixture.public_key,
        Transition::CandidateRegistered,
        mutations,
    );
}

#[test]
fn every_approved_transition_field_is_exactly_bound() {
    let fixture = Fixture::new();
    let Transition::Approved(record) = &fixture.approved else {
        panic!("approved fixture kind");
    };
    let mutations: &[FieldMutation<ApprovedTransition>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("generation", |v| v.generation += 1),
        ("previous_transition_sha256", |v| {
            change_digest(&mut v.previous_transition_sha256)
        }),
        ("transition_kind", |v| change_text(&mut v.transition_kind)),
        ("prior_state", |v| change_text(&mut v.prior_state)),
        ("resulting_state", |v| change_text(&mut v.resulting_state)),
        ("candidate_sha256", |v| {
            change_digest(&mut v.candidate_sha256)
        }),
        ("approval_grant_sha256", |v| {
            change_digest(&mut v.approval_grant_sha256)
        }),
        ("approval_grant_signature_sha256", |v| {
            change_digest(&mut v.approval_grant_signature_sha256)
        }),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("operation_authority_incarnation_sha256", |v| {
            change_digest(&mut v.operation_authority_incarnation_sha256)
        }),
        ("trusted_at", |v| {
            v.trusted_at = "2026-09-03T12:05:01Z".to_owned()
        }),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_transition_mutations(
        record,
        &fixture.approved_signature,
        &fixture.public_key,
        Transition::Approved,
        mutations,
    );
}

#[test]
fn every_consumed_transition_field_is_exactly_bound() {
    let fixture = Fixture::new();
    let Transition::Consumed(record) = &fixture.consumed else {
        panic!("consumed fixture kind");
    };
    let mutations: &[FieldMutation<ConsumedTransition>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("generation", |v| v.generation += 1),
        ("previous_transition_sha256", |v| {
            change_digest(&mut v.previous_transition_sha256)
        }),
        ("transition_kind", |v| change_text(&mut v.transition_kind)),
        ("prior_state", |v| change_text(&mut v.prior_state)),
        ("resulting_state", |v| change_text(&mut v.resulting_state)),
        ("candidate_sha256", |v| {
            change_digest(&mut v.candidate_sha256)
        }),
        ("approval_grant_sha256", |v| {
            change_digest(&mut v.approval_grant_sha256)
        }),
        ("approval_grant_signature_sha256", |v| {
            change_digest(&mut v.approval_grant_signature_sha256)
        }),
        ("execution_ticket_sha256", |v| {
            change_digest(&mut v.execution_ticket_sha256)
        }),
        ("execution_ticket_signature_sha256", |v| {
            change_digest(&mut v.execution_ticket_signature_sha256)
        }),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("operation_authority_incarnation_sha256", |v| {
            change_digest(&mut v.operation_authority_incarnation_sha256)
        }),
        ("trusted_at", |v| {
            v.trusted_at = "2026-09-03T12:06:01Z".to_owned()
        }),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_transition_mutations(
        record,
        &fixture.consumed_signature,
        &fixture.public_key,
        Transition::Consumed,
        mutations,
    );
}

#[test]
fn every_candidate_expired_transition_field_is_exactly_bound() {
    let fixture = Fixture::new();
    let Transition::CandidateExpired(record) = &fixture.candidate_expired else {
        panic!("candidate closure fixture kind");
    };
    let mutations: &[FieldMutation<CandidateExpiredTransition>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("generation", |v| v.generation += 1),
        ("previous_transition_sha256", |v| {
            change_digest(&mut v.previous_transition_sha256)
        }),
        ("transition_kind", |v| change_text(&mut v.transition_kind)),
        ("prior_state", |v| change_text(&mut v.prior_state)),
        ("resulting_state", |v| change_text(&mut v.resulting_state)),
        ("candidate_sha256", |v| {
            change_digest(&mut v.candidate_sha256)
        }),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("operation_authority_incarnation_sha256", |v| {
            change_digest(&mut v.operation_authority_incarnation_sha256)
        }),
        ("closing_authority_incarnation_sha256", |v| {
            change_digest(&mut v.closing_authority_incarnation_sha256)
        }),
        ("action_challenge_sha256", |v| {
            change_digest(&mut v.action_challenge_sha256)
        }),
        ("authenticated_operator_identity_sha256", |v| {
            change_digest(&mut v.authenticated_operator_identity_sha256)
        }),
        ("os_authentication_session_sha256", |v| {
            change_digest(&mut v.os_authentication_session_sha256)
        }),
        ("authenticated_at", |v| {
            v.authenticated_at = "2026-09-03T12:14:29Z".to_owned()
        }),
        ("cutoff_at", |v| {
            v.cutoff_at = "2026-09-03T12:14:59Z".to_owned()
        }),
        ("trusted_at", |v| {
            v.trusted_at = "2026-09-03T12:15:01Z".to_owned()
        }),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_transition_mutations(
        record,
        &fixture.candidate_expired_signature,
        &fixture.public_key,
        Transition::CandidateExpired,
        mutations,
    );
}

#[test]
fn every_approval_expired_transition_field_is_exactly_bound() {
    let fixture = Fixture::new();
    let Transition::ApprovalExpired(record) = &fixture.approval_expired else {
        panic!("approval closure fixture kind");
    };
    let mutations: &[FieldMutation<ApprovalExpiredTransition>] = &[
        ("schema_version", |v| change_text(&mut v.schema_version)),
        ("generation", |v| v.generation += 1),
        ("previous_transition_sha256", |v| {
            change_digest(&mut v.previous_transition_sha256)
        }),
        ("transition_kind", |v| change_text(&mut v.transition_kind)),
        ("prior_state", |v| change_text(&mut v.prior_state)),
        ("resulting_state", |v| change_text(&mut v.resulting_state)),
        ("candidate_sha256", |v| {
            change_digest(&mut v.candidate_sha256)
        }),
        ("approval_grant_sha256", |v| {
            change_digest(&mut v.approval_grant_sha256)
        }),
        ("approval_grant_signature_sha256", |v| {
            change_digest(&mut v.approval_grant_signature_sha256)
        }),
        ("operation_id", |v| change_digest(&mut v.operation_id)),
        ("authorization_nonce", |v| {
            change_digest(&mut v.authorization_nonce)
        }),
        ("envelope_sha256", |v| change_digest(&mut v.envelope_sha256)),
        ("operation_authority_incarnation_sha256", |v| {
            change_digest(&mut v.operation_authority_incarnation_sha256)
        }),
        ("closing_authority_incarnation_sha256", |v| {
            change_digest(&mut v.closing_authority_incarnation_sha256)
        }),
        ("action_challenge_sha256", |v| {
            change_digest(&mut v.action_challenge_sha256)
        }),
        ("authenticated_operator_identity_sha256", |v| {
            change_digest(&mut v.authenticated_operator_identity_sha256)
        }),
        ("os_authentication_session_sha256", |v| {
            change_digest(&mut v.os_authentication_session_sha256)
        }),
        ("authenticated_at", |v| {
            v.authenticated_at = "2026-09-03T12:08:59Z".to_owned()
        }),
        ("cutoff_at", |v| {
            v.cutoff_at = "2026-09-03T12:09:29Z".to_owned()
        }),
        ("trusted_at", |v| {
            v.trusted_at = "2026-09-03T12:09:31Z".to_owned()
        }),
        ("issuer_public_key_sha256", |v| {
            change_digest(&mut v.issuer_public_key_sha256)
        }),
        ("detached_signature_sha256", |v| {
            change_digest(&mut v.detached_signature_sha256)
        }),
    ];
    assert_transition_mutations(
        record,
        &fixture.approval_expired_signature,
        &fixture.public_key,
        Transition::ApprovalExpired,
        mutations,
    );
}

fn wrong_domain_signature(domain: &str, unsigned: Vec<u8>) -> [u8; 64] {
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let mut preimage = Vec::with_capacity(domain.len() + 1 + unsigned.len());
    preimage.extend_from_slice(domain.as_bytes());
    preimage.push(b'\n');
    preimage.extend_from_slice(&unsigned);
    signing_key.sign(&preimage).to_bytes()
}

#[test]
fn signatures_keys_digests_and_domains_are_exact_for_every_signed_record_family() {
    let fixture = Fixture::new();
    let other_key = SyntheticRecordSigner::from_seed([8; 32]).public_key_bytes();

    let mut bad_grant_signature = fixture.grant_signature;
    bad_grant_signature[0] ^= 1;
    let mut bad_grant = fixture.grant.clone();
    bad_grant.detached_signature_sha256 = sha256_hex(&bad_grant_signature);
    assert_eq!(
        verify_grant(&bad_grant, &bad_grant_signature, &fixture.public_key),
        Err(CryptoError::Signature)
    );
    assert_eq!(
        verify_grant(&fixture.grant, &fixture.grant_signature, &other_key),
        Err(CryptoError::KeyPin)
    );
    let mut wrong_grant_issuer = fixture.grant.clone();
    change_digest(&mut wrong_grant_issuer.issuer_public_key_sha256);
    assert_eq!(
        verify_grant(
            &wrong_grant_issuer,
            &fixture.grant_signature,
            &fixture.public_key
        ),
        Err(CryptoError::KeyPin)
    );
    let mut wrong_grant_digest = fixture.grant.clone();
    change_digest(&mut wrong_grant_digest.detached_signature_sha256);
    assert_eq!(
        verify_grant(
            &wrong_grant_digest,
            &fixture.grant_signature,
            &fixture.public_key
        ),
        Err(CryptoError::SignatureDigest)
    );
    let mut wrong_domain_grant = fixture.grant.clone();
    let signature = wrong_domain_signature(
        TICKET_DOMAIN,
        wrong_domain_grant
            .encode_unsigned()
            .expect("grant unsigned"),
    );
    wrong_domain_grant.detached_signature_sha256 = sha256_hex(&signature);
    assert_eq!(
        verify_grant(&wrong_domain_grant, &signature, &fixture.public_key),
        Err(CryptoError::Signature)
    );

    let mut bad_ticket_signature = fixture.ticket_signature;
    bad_ticket_signature[0] ^= 1;
    let mut bad_ticket = fixture.ticket.clone();
    bad_ticket.detached_signature_sha256 = sha256_hex(&bad_ticket_signature);
    assert_eq!(
        verify_ticket(&bad_ticket, &bad_ticket_signature, &fixture.public_key),
        Err(CryptoError::Signature)
    );
    assert_eq!(
        verify_ticket(&fixture.ticket, &fixture.ticket_signature, &other_key),
        Err(CryptoError::KeyPin)
    );
    let mut wrong_ticket_issuer = fixture.ticket.clone();
    change_digest(&mut wrong_ticket_issuer.issuer_public_key_sha256);
    assert_eq!(
        verify_ticket(
            &wrong_ticket_issuer,
            &fixture.ticket_signature,
            &fixture.public_key
        ),
        Err(CryptoError::KeyPin)
    );
    let mut wrong_ticket_digest = fixture.ticket.clone();
    change_digest(&mut wrong_ticket_digest.detached_signature_sha256);
    assert_eq!(
        verify_ticket(
            &wrong_ticket_digest,
            &fixture.ticket_signature,
            &fixture.public_key
        ),
        Err(CryptoError::SignatureDigest)
    );
    let mut wrong_domain_ticket = fixture.ticket.clone();
    let signature = wrong_domain_signature(
        GRANT_DOMAIN,
        wrong_domain_ticket
            .encode_unsigned()
            .expect("ticket unsigned"),
    );
    wrong_domain_ticket.detached_signature_sha256 = sha256_hex(&signature);
    assert_eq!(
        verify_ticket(&wrong_domain_ticket, &signature, &fixture.public_key),
        Err(CryptoError::Signature)
    );

    for (name, transition, original_signature) in [
        (
            "candidate_registered",
            &fixture.registered,
            fixture.registered_signature,
        ),
        ("approved", &fixture.approved, fixture.approved_signature),
        ("consumed", &fixture.consumed, fixture.consumed_signature),
        (
            "candidate_expired",
            &fixture.candidate_expired,
            fixture.candidate_expired_signature,
        ),
        (
            "approval_expired",
            &fixture.approval_expired,
            fixture.approval_expired_signature,
        ),
    ] {
        let mut bad_signature = original_signature;
        bad_signature[0] ^= 1;
        let mut bad_transition = transition.clone();
        set_transition_signature_digest(&mut bad_transition, sha256_hex(&bad_signature));
        assert_eq!(
            verify_transition(&bad_transition, &bad_signature, &fixture.public_key),
            Err(CryptoError::Signature),
            "{name} accepted a wrong signature"
        );
        assert_eq!(
            verify_transition(transition, &original_signature, &other_key),
            Err(CryptoError::KeyPin),
            "{name} accepted a wrong pinned key"
        );
        let mut wrong_issuer = transition.clone();
        change_transition_issuer_digest(&mut wrong_issuer);
        assert_eq!(
            verify_transition(&wrong_issuer, &original_signature, &fixture.public_key),
            Err(CryptoError::KeyPin),
            "{name} accepted a wrong issuer digest"
        );
        let mut wrong_signature_digest = transition.clone();
        set_transition_signature_digest(&mut wrong_signature_digest, digest('0'));
        assert_eq!(
            verify_transition(
                &wrong_signature_digest,
                &original_signature,
                &fixture.public_key
            ),
            Err(CryptoError::SignatureDigest),
            "{name} accepted a wrong detached-signature digest"
        );
        let mut wrong_domain_transition = transition.clone();
        let signature = wrong_domain_signature(
            GRANT_DOMAIN,
            wrong_domain_transition
                .encode_unsigned()
                .expect("transition unsigned"),
        );
        set_transition_signature_digest(&mut wrong_domain_transition, sha256_hex(&signature));
        assert_eq!(
            verify_transition(&wrong_domain_transition, &signature, &fixture.public_key,),
            Err(CryptoError::Signature),
            "{name} accepted a signature from the grant domain"
        );
    }
}

fn assert_inventory_rejected(inventory: InventoryFiles, key: &[u8; 32], case: &str) {
    assert!(
        matches!(
            verify_inventory(&inventory, key),
            Err(JournalError::State | JournalError::Shape | JournalError::Crypto)
        ),
        "journal accepted cross-record mutation: {case}"
    );
}

fn transition_corpus_value(fixture: &Fixture) -> serde_json::Value {
    let signed = |transition: &Transition, signature: &[u8; 64]| {
        serde_json::json!({
            "canonicalHex": hex::encode(transition.encode().expect("transition bytes")),
            "rawSignatureHex": hex::encode(signature),
        })
    };
    serde_json::json!({
        "schemaVersion": 1,
        "publicKeyHex": hex::encode(fixture.public_key),
        "candidateRegistered": signed(&fixture.registered, &fixture.registered_signature),
        "approved": signed(&fixture.approved, &fixture.approved_signature),
        "consumed": signed(&fixture.consumed, &fixture.consumed_signature),
        "candidateExpired": signed(
            &fixture.candidate_expired,
            &fixture.candidate_expired_signature,
        ),
        "approvalExpired": signed(
            &fixture.approval_expired,
            &fixture.approval_expired_signature,
        ),
    })
}

fn verify_golden_transition(
    corpus: &serde_json::Value,
    name: &str,
    expected: &Transition,
    expected_signature: &[u8; 64],
    public_key: &[u8; 32],
) {
    let record = &corpus[name];
    let canonical_bytes = hex::decode(
        record["canonicalHex"]
            .as_str()
            .expect("canonical hex string"),
    )
    .expect("canonical hex bytes");
    let signature: [u8; 64] = hex::decode(
        record["rawSignatureHex"]
            .as_str()
            .expect("signature hex string"),
    )
    .expect("signature hex bytes")
    .try_into()
    .expect("64-byte raw signature");
    assert_eq!(
        canonical_bytes,
        expected.encode().expect("generated transition bytes"),
        "{name} canonical bytes changed"
    );
    assert_eq!(
        signature, *expected_signature,
        "{name} raw signature changed"
    );
    let decoded = Transition::decode(&canonical_bytes).expect("golden transition decodes exactly");
    assert_eq!(decoded, *expected, "{name} decoded record changed");
    verify_transition(&decoded, &signature, public_key).expect("golden signature verifies exactly");
}

#[test]
fn all_five_transition_bytes_and_raw_signatures_match_the_immutable_corpus() {
    let fixture = Fixture::new();
    let corpus: serde_json::Value = serde_json::from_str(include_str!("transition-v1.golden.json"))
        .expect("transition golden corpus");
    assert_eq!(corpus["schemaVersion"], 1);
    assert_eq!(
        corpus["publicKeyHex"].as_str(),
        Some(hex::encode(fixture.public_key).as_str())
    );
    assert_eq!(
        corpus,
        transition_corpus_value(&fixture),
        "the immutable transition corpus changed"
    );
    for (name, transition, signature) in [
        (
            "candidateRegistered",
            &fixture.registered,
            &fixture.registered_signature,
        ),
        ("approved", &fixture.approved, &fixture.approved_signature),
        ("consumed", &fixture.consumed, &fixture.consumed_signature),
        (
            "candidateExpired",
            &fixture.candidate_expired,
            &fixture.candidate_expired_signature,
        ),
        (
            "approvalExpired",
            &fixture.approval_expired,
            &fixture.approval_expired_signature,
        ),
    ] {
        verify_golden_transition(&corpus, name, transition, signature, &fixture.public_key);
    }
}

#[test]
fn cryptographically_valid_cross_record_and_repeated_bindings_are_rejected_by_the_journal() {
    let fixture = Fixture::new();
    verify_inventory(
        &fixture.registered_inventory(fixture.registered.clone(), fixture.registered_signature),
        &fixture.public_key,
    )
    .expect("valid registration baseline");
    verify_inventory(
        &fixture.approved_inventory(
            fixture.grant.clone(),
            fixture.grant_signature,
            fixture.approved.clone(),
            fixture.approved_signature,
        ),
        &fixture.public_key,
    )
    .expect("valid approval baseline");
    verify_inventory(
        &fixture.consumed_inventory(
            fixture.ticket.clone(),
            fixture.ticket_signature,
            fixture.consumed.clone(),
            fixture.consumed_signature,
        ),
        &fixture.public_key,
    )
    .expect("valid consume baseline");

    let mut mismatched_grant = fixture.grant.clone();
    change_digest(&mut mismatched_grant.target_fingerprint);
    let mismatched_grant_signature = fixture
        .signer
        .sign_approval_grant(&mismatched_grant)
        .expect("mismatched grant signature");
    mismatched_grant.detached_signature_sha256 = sha256_hex(&mismatched_grant_signature);
    verify_grant(
        &mismatched_grant,
        &mismatched_grant_signature,
        &fixture.public_key,
    )
    .expect("mismatched grant remains cryptographically valid");
    let mut mismatched_approved = fixture.approved.clone();
    let Transition::Approved(record) = &mut mismatched_approved else {
        panic!("approval fixture kind");
    };
    record.approval_grant_sha256 =
        sha256_hex(&mismatched_grant.encode().expect("mismatched grant bytes"));
    record.approval_grant_signature_sha256 = sha256_hex(&mismatched_grant_signature);
    let (mismatched_approved, mismatched_approved_signature) =
        resign_transition(mismatched_approved, &fixture.signer);
    assert_inventory_rejected(
        fixture.approved_inventory(
            mismatched_grant,
            mismatched_grant_signature,
            mismatched_approved,
            mismatched_approved_signature,
        ),
        &fixture.public_key,
        "grant-to-candidate binding",
    );

    let mut mismatched_ticket = fixture.ticket.clone();
    change_digest(&mut mismatched_ticket.operation_id);
    let mismatched_ticket_signature = fixture
        .signer
        .sign_execution_ticket(&mismatched_ticket)
        .expect("mismatched ticket signature");
    mismatched_ticket.detached_signature_sha256 = sha256_hex(&mismatched_ticket_signature);
    verify_ticket(
        &mismatched_ticket,
        &mismatched_ticket_signature,
        &fixture.public_key,
    )
    .expect("mismatched ticket remains cryptographically valid");
    let mut mismatched_consumed = fixture.consumed.clone();
    let Transition::Consumed(record) = &mut mismatched_consumed else {
        panic!("consume fixture kind");
    };
    record.execution_ticket_sha256 =
        sha256_hex(&mismatched_ticket.encode().expect("mismatched ticket bytes"));
    record.execution_ticket_signature_sha256 = sha256_hex(&mismatched_ticket_signature);
    let (mismatched_consumed, mismatched_consumed_signature) =
        resign_transition(mismatched_consumed, &fixture.signer);
    assert_inventory_rejected(
        fixture.consumed_inventory(
            mismatched_ticket,
            mismatched_ticket_signature,
            mismatched_consumed,
            mismatched_consumed_signature,
        ),
        &fixture.public_key,
        "ticket-to-grant binding",
    );

    let mut mismatched_registered = fixture.registered.clone();
    let Transition::CandidateRegistered(record) = &mut mismatched_registered else {
        panic!("registration fixture kind");
    };
    change_digest(&mut record.operation_id);
    let (mismatched_registered, signature) =
        resign_transition(mismatched_registered, &fixture.signer);
    assert_inventory_rejected(
        fixture.registered_inventory(mismatched_registered, signature),
        &fixture.public_key,
        "registration repeated operation id",
    );

    let mut mismatched_approved = fixture.approved.clone();
    let Transition::Approved(record) = &mut mismatched_approved else {
        panic!("approval fixture kind");
    };
    change_digest(&mut record.operation_id);
    let (mismatched_approved, signature) = resign_transition(mismatched_approved, &fixture.signer);
    assert_inventory_rejected(
        fixture.approved_inventory(
            fixture.grant.clone(),
            fixture.grant_signature,
            mismatched_approved,
            signature,
        ),
        &fixture.public_key,
        "approval repeated operation id",
    );

    let mut mismatched_consumed = fixture.consumed.clone();
    let Transition::Consumed(record) = &mut mismatched_consumed else {
        panic!("consume fixture kind");
    };
    change_digest(&mut record.operation_id);
    let (mismatched_consumed, signature) = resign_transition(mismatched_consumed, &fixture.signer);
    assert_inventory_rejected(
        fixture.consumed_inventory(
            fixture.ticket.clone(),
            fixture.ticket_signature,
            mismatched_consumed,
            signature,
        ),
        &fixture.public_key,
        "consume repeated operation id",
    );

    let mut mismatched_candidate_close = fixture.candidate_expired.clone();
    let Transition::CandidateExpired(record) = &mut mismatched_candidate_close else {
        panic!("candidate closure fixture kind");
    };
    change_digest(&mut record.action_challenge_sha256);
    let (mismatched_candidate_close, signature) =
        resign_transition(mismatched_candidate_close, &fixture.signer);
    assert_inventory_rejected(
        assemble_inventory(
            vec![fixture.candidate_bytes.clone()],
            vec![],
            vec![
                (fixture.registered.clone(), fixture.registered_signature),
                (mismatched_candidate_close, signature),
            ],
        ),
        &fixture.public_key,
        "candidate closure action binding",
    );

    let mut mismatched_approval_close = fixture.approval_expired.clone();
    let Transition::ApprovalExpired(record) = &mut mismatched_approval_close else {
        panic!("approval closure fixture kind");
    };
    change_digest(&mut record.action_challenge_sha256);
    let (mismatched_approval_close, signature) =
        resign_transition(mismatched_approval_close, &fixture.signer);
    assert_inventory_rejected(
        assemble_inventory(
            vec![
                fixture.candidate_bytes.clone(),
                fixture.grant.encode().expect("grant bytes"),
            ],
            vec![fixture.grant_signature],
            vec![
                (fixture.registered.clone(), fixture.registered_signature),
                (fixture.approved.clone(), fixture.approved_signature),
                (mismatched_approval_close, signature),
            ],
        ),
        &fixture.public_key,
        "approval closure action binding",
    );

    assert_eq!(
        fixture.candidate_sha256,
        sha256_hex(&fixture.candidate_bytes)
    );
}
