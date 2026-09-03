use std::collections::VecDeque;
use std::fs::{self, File, Permissions};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::{Arc, Mutex};

use crate::crypto::{CryptoError, RecordSigner, SyntheticRecordSigner, sha256_hex, verify_grant};
use crate::journal::storage::{
    ApproveCommand, CommitError, ConsumeCommand, HeadCas, JournalStore, RegisterCommand,
    RootAuthority, StatusCommand, TicketEntropy, TrustedClock,
};
use crate::journal::{
    InventoryFiles, JournalError, TransitionFile, VerifiedState, verify_inventory,
};
use crate::records::{
    ApprovalGrant, CANDIDATE_SCHEMA, Candidate, ExecutionTicket, GENESIS_SHA256, Transition,
};
use crate::state::{
    FreshAttendedAuthentication, RootVerifiedPreparedEnvelope, StateError, approve_candidate,
    close_approval, close_candidate, consume_grant, derive_approval_close_challenge,
    derive_candidate_close_challenge, plan_ticket, seal_candidate, sign_approved_transition,
    sign_candidate_registered_transition, sign_consumed_transition,
};

const NOW: &str = "2026-09-03T12:05:00Z";

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

fn candidate_at(
    operation: char,
    authorization_nonce: char,
    envelope: char,
    incarnation: char,
    envelope_expires_at: &str,
    external_expires_at: &str,
) -> Candidate {
    Candidate {
        schema_version: CANDIDATE_SCHEMA.to_owned(),
        operation_id: digest(operation),
        authorization_nonce: digest(authorization_nonce),
        target_fingerprint: digest('3'),
        target_selection_sha256: digest('4'),
        envelope_sha256: digest(envelope),
        envelope_expires_at: envelope_expires_at.to_owned(),
        external_exclusive_window_generation: 7,
        external_exclusive_window_evidence_sha256: digest('6'),
        external_exclusive_window_expires_at: external_expires_at.to_owned(),
        official_source_evidence_sha256: digest('7'),
        native_runtime_identity_sha256: digest('8'),
        child_sandbox_policy_sha256: digest('9'),
        phase_exec_topology_policy_sha256: digest('a'),
        child_cgroup_policy_sha256: digest('b'),
        apply_invocation_evidence_sha256: digest('c'),
        operation_authority_incarnation_sha256: digest(incarnation),
        candidate_binding_sha256: String::new(),
        approval_challenge_sha256: String::new(),
        stored_at: String::new(),
        cutoff_at: String::new(),
    }
}

fn candidate() -> Candidate {
    candidate_at(
        '1',
        '2',
        '5',
        'd',
        "2026-09-03T12:15:00Z",
        "2026-09-03T12:15:00.000Z",
    )
}

fn verified(candidate: &Candidate) -> RootVerifiedPreparedEnvelope {
    RootVerifiedPreparedEnvelope::synthetic(
        candidate,
        [
            "2026-09-03T12:04:01.000Z",
            "2026-09-03T12:04:01Z",
            "2026-09-03T12:04:01Z",
            "2026-09-03T12:04:01Z",
        ],
    )
    .expect("verified observations")
}

fn approval_authentication(
    candidate: &Candidate,
    session: char,
    authenticated_at: &str,
) -> FreshAttendedAuthentication {
    FreshAttendedAuthentication::synthetic(
        candidate.approval_challenge_sha256.clone(),
        digest('e'),
        digest(session),
        authenticated_at.to_owned(),
    )
}

fn set_transition_signature(transition: &mut Transition, digest: String) {
    match transition {
        Transition::CandidateRegistered(record) => record.detached_signature_sha256 = digest,
        Transition::Approved(record) => record.detached_signature_sha256 = digest,
        Transition::Consumed(record) => record.detached_signature_sha256 = digest,
        Transition::CandidateExpired(record) => record.detached_signature_sha256 = digest,
        Transition::ApprovalExpired(record) => record.detached_signature_sha256 = digest,
    }
}

fn sign_raw_transition(
    mut transition: Transition,
    signer: &SyntheticRecordSigner,
) -> (Transition, [u8; 64]) {
    let signature = match &transition {
        Transition::CandidateRegistered(value) => signer
            .sign_candidate_registered_transition(value)
            .expect("registration signature"),
        Transition::Approved(value) => signer
            .sign_approved_transition(value)
            .expect("approval transition signature"),
        Transition::Consumed(value) => signer
            .sign_consumed_transition(value)
            .expect("consume transition signature"),
        Transition::CandidateExpired(value) => signer
            .sign_candidate_expired_transition(value)
            .expect("candidate closure signature"),
        Transition::ApprovalExpired(value) => signer
            .sign_approval_expired_transition(value)
            .expect("approval closure signature"),
    };
    set_transition_signature(&mut transition, sha256_hex(&signature));
    (transition, signature)
}

fn add_leaf(inventory: &mut InventoryFiles, bytes: Vec<u8>) {
    inventory.leaves.insert(sha256_hex(&bytes), bytes);
}

fn add_signature(inventory: &mut InventoryFiles, signature: [u8; 64]) {
    inventory
        .signatures
        .insert(sha256_hex(&signature), signature.to_vec());
}

fn add_transition(inventory: &mut InventoryFiles, transition: &Transition, signature: [u8; 64]) {
    let bytes = transition.encode().expect("transition bytes");
    add_signature(inventory, signature);
    inventory.transitions.insert(
        transition.generation(),
        TransitionFile {
            digest: sha256_hex(&bytes),
            bytes,
        },
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Node {
    Empty,
    Candidate,
    Approved,
    Consumed,
    CandidateExpired,
    ApprovalExpired,
}

impl Node {
    const ALL: [Self; 6] = [
        Self::Empty,
        Self::Candidate,
        Self::Approved,
        Self::Consumed,
        Self::CandidateExpired,
        Self::ApprovalExpired,
    ];

    fn state_name(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Candidate => "candidate_registered",
            Self::Approved => "approved",
            Self::Consumed => "consumed",
            Self::CandidateExpired => "candidate_expired",
            Self::ApprovalExpired => "approval_expired",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Edge {
    Register,
    Approve,
    Consume,
    ExpireCandidate,
    ExpireApproval,
}

impl Edge {
    const ALL: [Self; 5] = [
        Self::Register,
        Self::Approve,
        Self::Consume,
        Self::ExpireCandidate,
        Self::ExpireApproval,
    ];
}

fn legal(source: Node, edge: Edge) -> bool {
    matches!(
        (source, edge),
        (Node::Empty, Edge::Register)
            | (Node::Candidate, Edge::Approve | Edge::ExpireCandidate)
            | (Node::Approved, Edge::Consume | Edge::ExpireApproval)
            | (
                Node::CandidateExpired | Node::ApprovalExpired,
                Edge::Register
            )
    )
}

struct EdgeFixture {
    signer: SyntheticRecordSigner,
    public_key: [u8; 32],
    candidate_a: Candidate,
    candidate_b: Candidate,
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

impl EdgeFixture {
    fn new() -> Self {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let mut candidate_a = candidate();
        seal_candidate(&mut candidate_a, NOW).expect("candidate A");
        let candidate_a_sha256 = sha256_hex(&candidate_a.encode().expect("candidate A bytes"));
        let (grant, grant_signature) = approve_candidate(
            &candidate_a,
            &verified(&candidate_a),
            &approval_authentication(&candidate_a, 'f', "2026-09-03T12:04:30Z"),
            NOW,
            &signer,
        )
        .expect("grant");
        let (ticket, ticket_signature) = consume_grant(
            &candidate_a,
            &grant,
            &grant_signature,
            "2026-09-03T12:06:00Z",
            [3; 32],
            &signer,
        )
        .expect("ticket");
        let (registered, registered_signature) = sign_candidate_registered_transition(
            &candidate_a,
            candidate_a_sha256.clone(),
            1,
            GENESIS_SHA256.to_owned(),
            "empty".to_owned(),
            NOW.to_owned(),
            &signer,
        )
        .expect("registration");
        let registered_sha256 = sha256_hex(&registered.encode().expect("registration bytes"));
        let grant_sha256 = sha256_hex(&grant.encode().expect("grant bytes"));
        let grant_signature_sha256 = sha256_hex(&grant_signature);
        let (approved, approved_signature) = sign_approved_transition(
            &candidate_a,
            candidate_a_sha256.clone(),
            &grant,
            grant_sha256.clone(),
            grant_signature_sha256.clone(),
            2,
            registered_sha256.clone(),
            NOW.to_owned(),
            &signer,
        )
        .expect("approved");
        let approved_sha256 = sha256_hex(&approved.encode().expect("approved bytes"));
        let ticket_sha256 = sha256_hex(&ticket.encode().expect("ticket bytes"));
        let ticket_signature_sha256 = sha256_hex(&ticket_signature);
        let (consumed, consumed_signature) = sign_consumed_transition(
            &candidate_a,
            candidate_a_sha256.clone(),
            &grant,
            grant_sha256.clone(),
            grant_signature_sha256.clone(),
            &ticket,
            ticket_sha256,
            ticket_signature_sha256,
            3,
            approved_sha256.clone(),
            "2026-09-03T12:06:00Z".to_owned(),
            &signer,
        )
        .expect("consumed");
        let candidate_challenge = derive_candidate_close_challenge(
            &registered_sha256,
            &candidate_a_sha256,
            &candidate_a.approval_challenge_sha256,
        )
        .expect("candidate challenge");
        let candidate_close_auth = FreshAttendedAuthentication::synthetic(
            candidate_challenge.clone(),
            digest('e'),
            digest('0'),
            "2026-09-03T12:14:30Z".to_owned(),
        );
        let (candidate_expired, candidate_expired_signature) = close_candidate(
            &candidate_a,
            candidate_a_sha256.clone(),
            2,
            registered_sha256,
            digest('e'),
            candidate_challenge,
            &candidate_close_auth,
            "2026-09-03T12:15:00Z".to_owned(),
            &signer,
        )
        .expect("candidate expired");
        let approval_challenge = derive_approval_close_challenge(
            &approved_sha256,
            &candidate_a_sha256,
            &candidate_a.approval_challenge_sha256,
            &grant_sha256,
            &grant_signature_sha256,
        )
        .expect("approval challenge");
        let approval_close_auth = FreshAttendedAuthentication::synthetic(
            approval_challenge.clone(),
            digest('e'),
            digest('0'),
            "2026-09-03T12:09:00Z".to_owned(),
        );
        let (approval_expired, approval_expired_signature) = close_approval(
            &candidate_a,
            candidate_a_sha256,
            &grant,
            &grant_signature,
            grant_sha256,
            grant_signature_sha256,
            3,
            approved_sha256,
            digest('e'),
            approval_challenge,
            &approval_close_auth,
            "2026-09-03T12:09:30Z".to_owned(),
            &signer,
        )
        .expect("approval expired");

        let mut candidate_b = candidate_at(
            'a',
            'b',
            'c',
            '4',
            "2026-09-03T12:30:00Z",
            "2026-09-03T12:30:00.000Z",
        );
        seal_candidate(&mut candidate_b, "2026-09-03T12:16:00Z").expect("candidate B");

        Self {
            signer,
            public_key,
            candidate_a,
            candidate_b,
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

    fn source_inventory(&self, node: Node) -> InventoryFiles {
        let mut inventory = InventoryFiles::empty();
        if node == Node::Empty {
            return inventory;
        }
        add_leaf(
            &mut inventory,
            self.candidate_a.encode().expect("candidate bytes"),
        );
        add_transition(&mut inventory, &self.registered, self.registered_signature);
        if matches!(
            node,
            Node::Approved | Node::Consumed | Node::ApprovalExpired
        ) {
            add_leaf(&mut inventory, self.grant.encode().expect("grant bytes"));
            add_signature(&mut inventory, self.grant_signature);
            add_transition(&mut inventory, &self.approved, self.approved_signature);
        }
        match node {
            Node::Consumed => {
                add_leaf(&mut inventory, self.ticket.encode().expect("ticket bytes"));
                add_signature(&mut inventory, self.ticket_signature);
                add_transition(&mut inventory, &self.consumed, self.consumed_signature);
            }
            Node::CandidateExpired => add_transition(
                &mut inventory,
                &self.candidate_expired,
                self.candidate_expired_signature,
            ),
            Node::ApprovalExpired => add_transition(
                &mut inventory,
                &self.approval_expired,
                self.approval_expired_signature,
            ),
            Node::Empty | Node::Candidate | Node::Approved => {}
        }
        inventory
    }

    fn append_edge(
        &self,
        mut inventory: InventoryFiles,
        source: Node,
        edge: Edge,
    ) -> InventoryFiles {
        let snapshot = verify_inventory(&inventory, &self.public_key).expect("valid source");
        let generation = snapshot.generation + 1;
        let previous = snapshot.transition_sha256;
        let mut transition = match edge {
            Edge::Register => {
                add_leaf(
                    &mut inventory,
                    self.candidate_b.encode().expect("candidate B bytes"),
                );
                let Transition::CandidateRegistered(mut value) = self.registered.clone() else {
                    panic!("registration kind");
                };
                value.candidate_sha256 =
                    sha256_hex(&self.candidate_b.encode().expect("candidate B bytes"));
                value.operation_id = self.candidate_b.operation_id.clone();
                value.authorization_nonce = self.candidate_b.authorization_nonce.clone();
                value.envelope_sha256 = self.candidate_b.envelope_sha256.clone();
                value.operation_authority_incarnation_sha256 = self
                    .candidate_b
                    .operation_authority_incarnation_sha256
                    .clone();
                value.candidate_binding_sha256 = self.candidate_b.candidate_binding_sha256.clone();
                value.approval_challenge_sha256 =
                    self.candidate_b.approval_challenge_sha256.clone();
                value.trusted_at = self.candidate_b.stored_at.clone();
                value.prior_state = source.state_name().to_owned();
                Transition::CandidateRegistered(value)
            }
            Edge::Approve => {
                add_leaf(&mut inventory, self.grant.encode().expect("grant bytes"));
                add_signature(&mut inventory, self.grant_signature);
                self.approved.clone()
            }
            Edge::Consume => {
                add_leaf(&mut inventory, self.ticket.encode().expect("ticket bytes"));
                add_signature(&mut inventory, self.ticket_signature);
                self.consumed.clone()
            }
            Edge::ExpireCandidate => self.candidate_expired.clone(),
            Edge::ExpireApproval => self.approval_expired.clone(),
        };
        match &mut transition {
            Transition::CandidateRegistered(value) => {
                value.generation = generation;
                value.previous_transition_sha256 = previous;
            }
            Transition::Approved(value) => {
                value.generation = generation;
                value.previous_transition_sha256 = previous;
            }
            Transition::Consumed(value) => {
                value.generation = generation;
                value.previous_transition_sha256 = previous;
            }
            Transition::CandidateExpired(value) => {
                value.generation = generation;
                value.previous_transition_sha256 = previous;
            }
            Transition::ApprovalExpired(value) => {
                value.generation = generation;
                value.previous_transition_sha256 = previous;
            }
        }
        let (transition, signature) = sign_raw_transition(transition, &self.signer);
        add_transition(&mut inventory, &transition, signature);
        inventory
    }
}

#[test]
fn complete_state_edge_table_accepts_seven_legal_and_rejects_twenty_three_illegal_edges() {
    let fixture = EdgeFixture::new();
    let mut legal_count = 0;
    let mut illegal_count = 0;
    for source in Node::ALL {
        let source_inventory = fixture.source_inventory(source);
        verify_inventory(&source_inventory, &fixture.public_key).expect("source state");
        for edge in Edge::ALL {
            let result = verify_inventory(
                &fixture.append_edge(source_inventory.clone(), source, edge),
                &fixture.public_key,
            );
            if legal(source, edge) {
                legal_count += 1;
                assert!(
                    result.is_ok(),
                    "legal edge {source:?} -> {edge:?}: {result:?}"
                );
            } else {
                illegal_count += 1;
                assert!(result.is_err(), "illegal edge {source:?} -> {edge:?}");
            }
        }
    }
    assert_eq!((legal_count, illegal_count), (7, 23));
}

fn resign_grant(
    mut grant: ApprovalGrant,
    signer: &SyntheticRecordSigner,
) -> (ApprovalGrant, [u8; 64]) {
    grant.issuer_public_key_sha256 = sha256_hex(&signer.public_key_bytes());
    let signature = signer.sign_approval_grant(&grant).expect("grant signature");
    grant.detached_signature_sha256 = sha256_hex(&signature);
    (grant, signature)
}

#[test]
fn cryptographically_valid_grants_refuse_each_cross_operation_policy_binding() {
    let fixture = EdgeFixture::new();
    type GrantMutation = (&'static str, fn(&mut ApprovalGrant));
    let mutations: &[GrantMutation] = &[
        ("operation", |grant| grant.operation_id = digest('0')),
        ("authorization nonce", |grant| {
            grant.authorization_nonce = digest('0')
        }),
        ("target fingerprint", |grant| {
            grant.target_fingerprint = digest('0')
        }),
        ("target selection", |grant| {
            grant.target_selection_sha256 = digest('0')
        }),
        ("envelope", |grant| grant.envelope_sha256 = digest('0')),
        ("external window generation", |grant| {
            grant.external_exclusive_window_generation += 1
        }),
        ("external window evidence", |grant| {
            grant.external_exclusive_window_evidence_sha256 = digest('0');
        }),
    ];
    for (name, mutate) in mutations {
        let mut changed = fixture.grant.clone();
        mutate(&mut changed);
        let (changed, signature) = resign_grant(changed, &fixture.signer);
        verify_grant(&changed, &signature, &fixture.public_key)
            .expect("mutated grant remains cryptographically valid");
        assert_eq!(
            plan_ticket(
                &fixture.candidate_a,
                &changed,
                &signature,
                "2026-09-03T12:06:00Z",
                [4; 32],
                &fixture.public_key,
            )
            .err(),
            Some(StateError::PolicyMismatch),
            "{name} replay was accepted"
        );
    }

    let other_signer = SyntheticRecordSigner::from_seed([8; 32]);
    let (other_key_grant, other_signature) = resign_grant(fixture.grant.clone(), &other_signer);
    assert_eq!(
        verify_grant(&other_key_grant, &other_signature, &fixture.public_key),
        Err(CryptoError::KeyPin)
    );
    assert_eq!(
        plan_ticket(
            &fixture.candidate_a,
            &other_key_grant,
            &other_signature,
            "2026-09-03T12:06:00Z",
            [4; 32],
            &fixture.public_key,
        )
        .err(),
        Some(StateError::Crypto)
    );
}

#[test]
fn authentication_session_uniqueness_survives_terminal_operation_and_complete_rescan() {
    let fixture = EdgeFixture::new();
    let mut inventory = fixture.source_inventory(Node::CandidateExpired);
    let prior =
        verify_inventory(&inventory, &fixture.public_key).expect("first terminal operation");
    let candidate_b_sha256 = sha256_hex(&fixture.candidate_b.encode().expect("candidate B bytes"));
    let (registered_b, registered_b_signature) = sign_candidate_registered_transition(
        &fixture.candidate_b,
        candidate_b_sha256.clone(),
        prior.generation + 1,
        prior.transition_sha256,
        "candidate_expired".to_owned(),
        fixture.candidate_b.stored_at.clone(),
        &fixture.signer,
    )
    .expect("second registration");
    add_leaf(
        &mut inventory,
        fixture.candidate_b.encode().expect("candidate B bytes"),
    );
    add_transition(&mut inventory, &registered_b, registered_b_signature);
    let registered_b_sha256 = sha256_hex(&registered_b.encode().expect("registered B bytes"));
    verify_inventory(&inventory, &fixture.public_key).expect("second registered operation");

    let challenge = derive_candidate_close_challenge(
        &registered_b_sha256,
        &candidate_b_sha256,
        &fixture.candidate_b.approval_challenge_sha256,
    )
    .expect("second close challenge");
    let replayed_authentication = FreshAttendedAuthentication::synthetic(
        challenge.clone(),
        digest('f'),
        digest('0'),
        "2026-09-03T12:29:30Z".to_owned(),
    );
    let (replayed_close, replayed_signature) = close_candidate(
        &fixture.candidate_b,
        candidate_b_sha256,
        4,
        registered_b_sha256,
        digest('f'),
        challenge,
        &replayed_authentication,
        "2026-09-03T12:30:00Z".to_owned(),
        &fixture.signer,
    )
    .expect("locally valid replayed closure");
    add_transition(&mut inventory, &replayed_close, replayed_signature);
    assert_eq!(
        verify_inventory(&inventory, &fixture.public_key),
        Err(JournalError::State)
    );
    let reopened_complete_inventory = inventory.clone();
    assert_eq!(
        verify_inventory(&reopened_complete_inventory, &fixture.public_key),
        Err(JournalError::State)
    );
}

fn grant_with_expiries(
    envelope_expires_at: &str,
    external_expires_at: &str,
    authenticated_at: &str,
) -> ApprovalGrant {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let mut value = candidate_at('1', '2', '5', 'd', envelope_expires_at, external_expires_at);
    seal_candidate(&mut value, NOW).expect("candidate for expiry case");
    approve_candidate(
        &value,
        &verified(&value),
        &approval_authentication(&value, 'f', authenticated_at),
        NOW,
        &signer,
    )
    .expect("grant for expiry case")
    .0
}

#[test]
fn grant_expiry_uses_each_reachable_source_and_preserves_equal_mixed_precision_precedence() {
    let cases = [
        (
            "envelope",
            "2026-09-03T12:06:00Z",
            "2026-09-03T12:08:00.250Z",
            "2026-09-03T12:04:30Z",
            "2026-09-03T12:06:00Z",
        ),
        (
            "external window",
            "2026-09-03T12:10:00Z",
            "2026-09-03T12:06:00.250Z",
            "2026-09-03T12:04:30Z",
            "2026-09-03T12:06:00.250Z",
        ),
        (
            "authentication deadline",
            "2026-09-03T12:10:00Z",
            "2026-09-03T12:10:00.250Z",
            "2026-09-03T12:01:30Z",
            "2026-09-03T12:06:30Z",
        ),
        (
            "equal envelope/external mixed precision",
            "2026-09-03T12:06:00Z",
            "2026-09-03T12:06:00.000Z",
            "2026-09-03T12:04:30Z",
            "2026-09-03T12:06:00Z",
        ),
    ];
    for (name, envelope, external, authenticated, expected) in cases {
        assert_eq!(
            grant_with_expiries(envelope, external, authenticated).expires_at,
            expected,
            "{name}"
        );
    }

    let issue_deadline_dominated =
        grant_with_expiries("2026-09-03T12:20:00Z", "2026-09-03T12:20:00.250Z", NOW);
    assert_eq!(issue_deadline_dominated.expires_at, "2026-09-03T12:10:00Z");
    assert_ne!(issue_deadline_dominated.expires_at, "2026-09-03T12:20:00Z");
}

struct MutableClock(Arc<Mutex<String>>);

impl TrustedClock for MutableClock {
    fn sample(&self) -> Result<String, ()> {
        self.0.lock().map(|value| value.clone()).map_err(|_| ())
    }
}

struct SequenceEntropy {
    values: Mutex<VecDeque<Result<[u8; 32], ()>>>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl SequenceEntropy {
    fn new(
        values: impl IntoIterator<Item = Result<[u8; 32], ()>>,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        Self {
            values: Mutex::new(values.into_iter().collect()),
            calls,
        }
    }
}

impl TicketEntropy for SequenceEntropy {
    fn draw_once(&self) -> Result<[u8; 32], ()> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.values.lock().map_err(|_| ())?.pop_front().ok_or(())?
    }
}

fn empty_test_store(public_key: [u8; 32]) -> (tempfile::TempDir, JournalStore) {
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
    let root_fd: OwnedFd = File::open(root).expect("root fd").into();
    let store = JournalStore::open_from_fd(root_fd, metadata.uid(), metadata.gid(), public_key)
        .expect("journal store");
    (directory, store)
}

fn reopen_test_store(root: &std::path::Path, public_key: [u8; 32]) -> JournalStore {
    let metadata = fs::metadata(root).expect("root metadata");
    let root_fd: OwnedFd = File::open(root).expect("root fd").into();
    JournalStore::open_from_fd(root_fd, metadata.uid(), metadata.gid(), public_key)
        .expect("reopened journal store")
}

#[test]
fn future_clock_and_status_do_not_close_or_release_a_registered_candidate() {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let clock_value = Arc::new(Mutex::new(NOW.to_owned()));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        signer,
        MutableClock(Arc::clone(&clock_value)),
        SequenceEntropy::new([Ok([9; 32])], calls),
    )
    .expect("authority");
    let register = authority.register(RegisterCommand::new(
        HeadCas::new(0, GENESIS_SHA256.to_owned()),
        candidate(),
    ));
    assert!(register.is_ok());
    drop(register);
    let snapshot = authority.inspect().expect("candidate state").1;
    let operation_id = snapshot
        .state
        .operation_id()
        .expect("operation id")
        .to_owned();
    let generation = snapshot.generation;
    let transition_sha256 = snapshot.transition_sha256.clone();

    *clock_value.lock().expect("clock") = "2030-01-01T00:00:00Z".to_owned();
    let status = authority.status(StatusCommand::new(operation_id));
    assert_eq!(
        status.test_snapshot(),
        (
            "candidate_registered",
            Some(generation),
            Some(transition_sha256.as_str())
        )
    );
    drop(status);
    let second_register = authority.register(RegisterCommand::new(
        HeadCas::new(generation, transition_sha256),
        candidate_at(
            'a',
            'b',
            'c',
            '4',
            "2030-01-01T00:10:00Z",
            "2030-01-01T00:10:00.000Z",
        ),
    ));
    assert_eq!(
        second_register.test_error(),
        Some(CommitError::InvalidState)
    );
    drop(second_register);
    assert!(matches!(
        authority.inspect().expect("candidate remains").1.state,
        VerifiedState::CandidateRegistered { .. }
    ));
}

#[test]
fn ticket_entropy_failure_draws_once_and_preserves_the_approved_predecessor() {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        signer,
        MutableClock(Arc::new(Mutex::new(NOW.to_owned()))),
        SequenceEntropy::new([Ok([9; 32]), Err(())], Arc::clone(&calls)),
    )
    .expect("authority");
    let register = authority.register(RegisterCommand::new(
        HeadCas::new(0, GENESIS_SHA256.to_owned()),
        candidate(),
    ));
    assert!(register.is_ok());
    drop(register);
    let registered = authority.inspect().expect("registered").1;
    let value = match &registered.state {
        VerifiedState::CandidateRegistered { candidate, .. } => candidate.as_ref().clone(),
        _ => panic!("candidate state"),
    };
    let approve = authority.approve(
        ApproveCommand::new(
            HeadCas::new(registered.generation, registered.transition_sha256),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            value.approval_challenge_sha256.clone(),
        ),
        &verified(&value),
        &approval_authentication(&value, 'f', "2026-09-03T12:04:30Z"),
    );
    assert!(approve.is_ok());
    drop(approve);
    let approved = authority.inspect().expect("approved").1;
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    let consume = authority.consume(ConsumeCommand::new(
        HeadCas::new(approved.generation, approved.transition_sha256),
        value.operation_id,
        value.authorization_nonce,
        grant_sha256,
        grant_signature_sha256,
    ));
    assert_eq!(consume.test_error(), Some(CommitError::Entropy));
    drop(consume);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(matches!(
        authority.inspect().expect("approved predecessor").1.state,
        VerifiedState::Approved { .. }
    ));
}

#[test]
fn persisted_incarnation_entropy_collision_refuses_after_exactly_one_draw() {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let first_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        signer,
        MutableClock(Arc::new(Mutex::new(NOW.to_owned()))),
        SequenceEntropy::new([Ok([9; 32])], Arc::clone(&first_calls)),
    )
    .expect("first authority");
    let registered = authority.register(RegisterCommand::new(
        HeadCas::new(0, GENESIS_SHA256.to_owned()),
        candidate(),
    ));
    assert!(registered.is_ok());
    drop(registered);
    drop(authority);
    assert_eq!(first_calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    let collision_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let collision = RootAuthority::synthetic(
        reopen_test_store(directory.path(), public_key),
        SyntheticRecordSigner::from_seed([7; 32]),
        MutableClock(Arc::new(Mutex::new(NOW.to_owned()))),
        SequenceEntropy::new([Ok([9; 32])], Arc::clone(&collision_calls)),
    );
    assert!(matches!(collision, Err(CommitError::Collision)));
    assert_eq!(collision_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}
