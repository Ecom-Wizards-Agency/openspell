use crate::canonical::{FieldValue, object};
use crate::crypto::{
    CryptoError, RecordSigner, SyntheticRecordSigner, sha256_hex, verify_grant, verify_ticket,
    verify_transition,
};
use crate::journal::storage::{
    ApproveCommand, CloseApprovalCommand, CloseCandidateCommand, CommitError, ConsumeCommand,
    HeadCas, Health, JournalStore, OpenError, RegisterCommand, RootAuthority, StatusCommand,
    StorageError, TestFaultPoint, TestPublicationBoundary, TicketEntropy, TrustedClock,
    test_clear_fault, test_fail_at, test_park_at,
};
use crate::journal::{
    DurableSuccess, InventoryFiles, JournalError, TransitionFile, VerifiedState, VerifiedStatus,
    verify_inventory,
};
use crate::protocol::{
    ApproveSuccess, CloseApprovalSuccess, CloseCandidateSuccess, ConsumeSuccess, OPERATOR_APPROVE,
    OPERATOR_APPROVE_SUCCESS, OPERATOR_CLOSE_APPROVAL_SUCCESS, OPERATOR_CLOSE_CANDIDATE_SUCCESS,
    OPERATOR_REFUSAL, OperatorDecode, OperatorRefusal, OperatorRequestFamily, OperatorResponse,
    RefusalCode, RegisterSuccess, SUPERVISOR_CONSUME, SUPERVISOR_CONSUME_SUCCESS,
    SUPERVISOR_REFUSAL, SUPERVISOR_REGISTER_SUCCESS, SUPERVISOR_STATUS, SUPERVISOR_STATUS_SUCCESS,
    StatusAvailability, StatusResponse, SupervisorDecode, SupervisorRefusal, SupervisorRequest,
    SupervisorRequestFamily, SupervisorResponse, decode_operator, decode_supervisor, encode_frame,
    encode_operator_response, encode_supervisor_response,
};
use crate::records::{
    ApprovalExpiredTransition, ApprovalGrant, ApprovedTransition, CANDIDATE_SCHEMA, Candidate,
    CandidateExpiredTransition, CandidateRegisteredTransition, ConsumedTransition, ExecutionTicket,
    GENESIS_SHA256, Transition,
};
use crate::state::{
    FreshAttendedAuthentication, RootVerifiedPreparedEnvelope, StateError, approve_candidate,
    close_approval, close_candidate, consume_grant, derive_approval_close_challenge,
    derive_candidate_close_challenge, seal_candidate, sign_approved_transition,
    sign_candidate_registered_transition, sign_consumed_transition,
};

const NOW: &str = "2026-09-03T12:05:00Z";

struct FixedClock(&'static str);

impl TrustedClock for FixedClock {
    fn sample(&self) -> Result<String, ()> {
        Ok(self.0.to_owned())
    }
}

struct FixedEntropy([u8; 32]);

impl TicketEntropy for FixedEntropy {
    fn draw_once(&self) -> Result<[u8; 32], ()> {
        Ok(self.0)
    }
}

struct SequenceClock(std::sync::Mutex<std::collections::VecDeque<&'static str>>);

impl SequenceClock {
    fn new(values: impl IntoIterator<Item = &'static str>) -> Self {
        Self(std::sync::Mutex::new(values.into_iter().collect()))
    }
}

struct SequenceEntropy(std::sync::Mutex<std::collections::VecDeque<Result<[u8; 32], ()>>>);

impl SequenceEntropy {
    fn new(values: impl IntoIterator<Item = Result<[u8; 32], ()>>) -> Self {
        Self(std::sync::Mutex::new(values.into_iter().collect()))
    }
}

impl TicketEntropy for SequenceEntropy {
    fn draw_once(&self) -> Result<[u8; 32], ()> {
        self.0.lock().map_err(|_| ())?.pop_front().ok_or(())?
    }
}

impl TrustedClock for SequenceClock {
    fn sample(&self) -> Result<String, ()> {
        self.0
            .lock()
            .map_err(|_| ())?
            .pop_front()
            .map(str::to_owned)
            .ok_or(())
    }
}

struct CountingClock {
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl TrustedClock for CountingClock {
    fn sample(&self) -> Result<String, ()> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(NOW.to_owned())
    }
}

struct CountingEntropy {
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl TicketEntropy for CountingEntropy {
    fn draw_once(&self) -> Result<[u8; 32], ()> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok([3; 32])
    }
}

struct CountingEntropyValue {
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    value: [u8; 32],
}

impl TicketEntropy for CountingEntropyValue {
    fn draw_once(&self) -> Result<[u8; 32], ()> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self.value)
    }
}

struct CountingSigner {
    inner: SyntheticRecordSigner,
    calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl CountingSigner {
    fn called(&self) {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl RecordSigner for CountingSigner {
    fn public_key_bytes(&self) -> [u8; 32] {
        self.inner.public_key_bytes()
    }

    fn sign_approval_grant(&self, grant: &ApprovalGrant) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_approval_grant(grant)
    }

    fn sign_execution_ticket(&self, ticket: &ExecutionTicket) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_execution_ticket(ticket)
    }

    fn sign_candidate_registered_transition(
        &self,
        transition: &CandidateRegisteredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_candidate_registered_transition(transition)
    }

    fn sign_approved_transition(
        &self,
        transition: &ApprovedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_approved_transition(transition)
    }

    fn sign_consumed_transition(
        &self,
        transition: &ConsumedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_consumed_transition(transition)
    }

    fn sign_candidate_expired_transition(
        &self,
        transition: &CandidateExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_candidate_expired_transition(transition)
    }

    fn sign_approval_expired_transition(
        &self,
        transition: &ApprovalExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.called();
        self.inner.sign_approval_expired_transition(transition)
    }
}

#[derive(Clone, Copy)]
enum FailingTransition {
    CandidateRegistered,
    Approved,
    Consumed,
    CandidateExpired,
    ApprovalExpired,
}

struct FailingTransitionSigner {
    inner: SyntheticRecordSigner,
    failure: FailingTransition,
}

impl FailingTransitionSigner {
    fn new(failure: FailingTransition) -> Self {
        Self {
            inner: SyntheticRecordSigner::from_seed([7; 32]),
            failure,
        }
    }

    fn should_fail(&self, failure: FailingTransition) -> bool {
        std::mem::discriminant(&self.failure) == std::mem::discriminant(&failure)
    }
}

impl RecordSigner for FailingTransitionSigner {
    fn public_key_bytes(&self) -> [u8; 32] {
        self.inner.public_key_bytes()
    }

    fn sign_approval_grant(&self, grant: &ApprovalGrant) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_approval_grant(grant)
    }

    fn sign_execution_ticket(&self, ticket: &ExecutionTicket) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_execution_ticket(ticket)
    }

    fn sign_candidate_registered_transition(
        &self,
        transition: &CandidateRegisteredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        if self.should_fail(FailingTransition::CandidateRegistered) {
            Err(CryptoError::Signature)
        } else {
            self.inner.sign_candidate_registered_transition(transition)
        }
    }

    fn sign_approved_transition(
        &self,
        transition: &ApprovedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        if self.should_fail(FailingTransition::Approved) {
            Err(CryptoError::Signature)
        } else {
            self.inner.sign_approved_transition(transition)
        }
    }

    fn sign_consumed_transition(
        &self,
        transition: &ConsumedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        if self.should_fail(FailingTransition::Consumed) {
            Err(CryptoError::Signature)
        } else {
            self.inner.sign_consumed_transition(transition)
        }
    }

    fn sign_candidate_expired_transition(
        &self,
        transition: &CandidateExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        if self.should_fail(FailingTransition::CandidateExpired) {
            Err(CryptoError::Signature)
        } else {
            self.inner.sign_candidate_expired_transition(transition)
        }
    }

    fn sign_approval_expired_transition(
        &self,
        transition: &ApprovalExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        if self.should_fail(FailingTransition::ApprovalExpired) {
            Err(CryptoError::Signature)
        } else {
            self.inner.sign_approval_expired_transition(transition)
        }
    }
}

struct ToggleKeySigner {
    inner: SyntheticRecordSigner,
    alternate_public_key: [u8; 32],
    wrong: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ToggleKeySigner {
    fn new(wrong: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Self {
        Self {
            inner: SyntheticRecordSigner::from_seed([7; 32]),
            alternate_public_key: SyntheticRecordSigner::from_seed([8; 32]).public_key_bytes(),
            wrong,
        }
    }
}

impl RecordSigner for ToggleKeySigner {
    fn public_key_bytes(&self) -> [u8; 32] {
        if self.wrong.load(std::sync::atomic::Ordering::SeqCst) {
            self.alternate_public_key
        } else {
            self.inner.public_key_bytes()
        }
    }

    fn sign_approval_grant(&self, grant: &ApprovalGrant) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_approval_grant(grant)
    }

    fn sign_execution_ticket(&self, ticket: &ExecutionTicket) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_execution_ticket(ticket)
    }

    fn sign_candidate_registered_transition(
        &self,
        transition: &CandidateRegisteredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_candidate_registered_transition(transition)
    }

    fn sign_approved_transition(
        &self,
        transition: &ApprovedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_approved_transition(transition)
    }

    fn sign_consumed_transition(
        &self,
        transition: &ConsumedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_consumed_transition(transition)
    }

    fn sign_candidate_expired_transition(
        &self,
        transition: &CandidateExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_candidate_expired_transition(transition)
    }

    fn sign_approval_expired_transition(
        &self,
        transition: &ApprovalExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.inner.sign_approval_expired_transition(transition)
    }
}

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
fn rust_generation_matches_the_checked_in_wp198_cross_oracle_corpus() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("grant-ticket-v1.golden.json")).expect("golden corpus");
    let numbers = |path: &[&str]| -> Vec<u8> {
        let mut value = &corpus;
        for segment in path {
            value = &value[*segment];
        }
        value
            .as_array()
            .expect("byte array")
            .iter()
            .map(|number| {
                u8::try_from(number.as_u64().expect("unsigned byte")).expect("bounded byte")
            })
            .collect()
    };

    let mut candidate = candidate("2026-09-03T12:15:00Z");
    seal_candidate(&mut candidate, NOW).expect("candidate");
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&candidate, observations()).expect("verified");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let (grant, grant_signature) = approve_candidate(
        &candidate,
        &verified,
        &authentication(&candidate),
        NOW,
        &signer,
    )
    .expect("grant");
    let (ticket, ticket_signature) = consume_grant(
        &candidate,
        &grant,
        &grant_signature,
        "2026-09-03T12:06:00Z",
        [3; 32],
        &signer,
    )
    .expect("ticket");

    assert_eq!(numbers(&["publicKeyBytes"]), signer.public_key_bytes());
    assert_eq!(
        numbers(&["approvalGrant", "canonicalBytes"]),
        grant.encode().expect("grant bytes")
    );
    assert_eq!(
        numbers(&["approvalGrant", "rawSignatureBytes"]),
        grant_signature
    );
    assert_eq!(
        numbers(&["executionTicket", "canonicalBytes"]),
        ticket.encode().expect("ticket bytes")
    );
    assert_eq!(
        numbers(&["executionTicket", "rawSignatureBytes"]),
        ticket_signature
    );
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

fn empty_test_store(pinned_public_key: [u8; 32]) -> (tempfile::TempDir, JournalStore) {
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
    let root_fd: OwnedFd = File::open(root).expect("root fd").into();
    let store =
        JournalStore::open_from_fd(root_fd, metadata.uid(), metadata.gid(), pinned_public_key)
            .expect("journal store");
    (directory, store)
}

fn reopen_test_store(root: &std::path::Path, pinned_public_key: [u8; 32]) -> JournalStore {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match open_test_store(root, pinned_public_key) {
            Ok(store) => return store,
            Err(OpenError::Lock) if std::time::Instant::now() < deadline => {
                // A concurrently spawned libtest child can briefly inherit another test's
                // close-on-exec OFD. The descriptor is gone as soon as exec completes.
                std::thread::yield_now();
            }
            Err(error) => panic!("reopened journal: {error:?}"),
        }
    }
}

fn open_test_store(
    root: &std::path::Path,
    pinned_public_key: [u8; 32],
) -> Result<JournalStore, OpenError> {
    use std::fs::File;
    use std::os::fd::OwnedFd;
    use std::os::unix::fs::MetadataExt;

    let metadata = root.metadata().expect("root metadata");
    let root_fd: OwnedFd = File::open(root).expect("root fd").into();
    JournalStore::open_from_fd(root_fd, metadata.uid(), metadata.gid(), pinned_public_key)
}

fn journal_entry_count(root: &std::path::Path) -> usize {
    fn visit(path: &std::path::Path) -> usize {
        std::fs::read_dir(path)
            .expect("journal directory")
            .map(|entry| {
                let path = entry.expect("journal entry").path();
                1 + if path.is_dir() { visit(&path) } else { 0 }
            })
            .sum()
    }
    visit(root)
}

fn publication_fault_points(publications: usize) -> Vec<TestFaultPoint> {
    let mut points = vec![TestFaultPoint::BeforeFirstPublication];
    for ordinal in 1..=publications {
        for boundary in [
            TestPublicationBoundary::FinalNameCreated,
            TestPublicationBoundary::PartialWrite,
            TestPublicationBoundary::CompleteWrite,
            TestPublicationBoundary::MetadataVerified,
            TestPublicationBoundary::FileSynced,
            TestPublicationBoundary::DirectorySynced,
        ] {
            points.push(TestFaultPoint::Publication { ordinal, boundary });
        }
    }
    points.push(TestFaultPoint::PostCommitVerified);
    points
}

fn fault_has_complete_transition(point: TestFaultPoint, transition_ordinal: usize) -> bool {
    match point {
        TestFaultPoint::PostCommitVerified => true,
        TestFaultPoint::Publication { ordinal, boundary } => {
            ordinal == transition_ordinal
                && matches!(
                    boundary,
                    TestPublicationBoundary::CompleteWrite
                        | TestPublicationBoundary::MetadataVerified
                        | TestPublicationBoundary::FileSynced
                        | TestPublicationBoundary::DirectorySynced
                )
        }
        TestFaultPoint::BeforeFirstPublication
        | TestFaultPoint::RegistryBeforeFinalValidation
        | TestFaultPoint::RegistryBeforeFinalCreate
        | TestFaultPoint::RegistryPostDurability => false,
        TestFaultPoint::Directory { .. } => false,
    }
}

const PROCESS_CHILD_ROLE: &str = "OPENSP_TEST_ROOT_AUTHORITY_CHILD_ROLE";
const PROCESS_CHILD_ROOT: &str = "OPENSP_TEST_ROOT_AUTHORITY_CHILD_ROOT";
const PROCESS_CHILD_COORDINATION: &str = "OPENSP_TEST_ROOT_AUTHORITY_CHILD_COORDINATION";
const PROCESS_CHILD_ID: &str = "OPENSP_TEST_ROOT_AUTHORITY_CHILD_ID";
const PROCESS_CHILD_EXPECTED: &str = "OPENSP_TEST_ROOT_AUTHORITY_CHILD_EXPECTED";
const PROCESS_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const PROCESS_IPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn process_marker(directory: &std::path::Path, kind: &str, id: &str) -> std::path::PathBuf {
    directory.join(format!("{kind}-{id}"))
}

fn write_process_marker(path: &std::path::Path, value: &str) {
    use std::io::Write;

    let pending = path.with_extension("pending");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)
        .expect("create process marker");
    file.write_all(value.as_bytes())
        .expect("write process marker");
    file.sync_all().expect("sync process marker");
    drop(file);
    std::fs::rename(pending, path).expect("publish process marker");
}

fn wait_for_process_marker(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for process marker {}",
            path.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

fn park_process_until_release(directory: &std::path::Path, id: &str) {
    wait_for_process_marker(&process_marker(directory, "release", id));
}

fn spawn_process_child(
    root: &std::path::Path,
    coordination: &std::path::Path,
    role: &str,
    id: &str,
    expected: Option<&str>,
) -> std::process::Child {
    use std::process::{Command, Stdio};

    let mut command = Command::new(std::env::current_exe().expect("current Rust test binary"));
    command
        .arg("--exact")
        .arg("tests::wp199_independent_process_child")
        .arg("--nocapture")
        .env(PROCESS_CHILD_ROLE, role)
        .env(PROCESS_CHILD_ROOT, root)
        .env(PROCESS_CHILD_COORDINATION, coordination)
        .env(PROCESS_CHILD_ID, id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(expected) = expected {
        command.env(PROCESS_CHILD_EXPECTED, expected);
    }
    command.spawn().expect("spawn independent test process")
}

fn wait_for_process_output(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> std::process::Output {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .expect("collect test process output");
            }
            Ok(None) if std::time::Instant::now() < deadline => std::thread::yield_now(),
            Ok(None) => {
                let kill_error = child.kill().err();
                let output = child
                    .wait_with_output()
                    .expect("reap timed-out test process");
                panic!(
                    "independent process timed out after {timeout:?}; kill error: {kill_error:?}\nstdout:\n{}\nstderr:\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(error) => panic!("inspect test process: {error}"),
        }
    }
}

fn assert_process_success(child: std::process::Child) {
    let output = wait_for_process_output(child, PROCESS_EXIT_TIMEOUT);
    assert!(
        output.status.success(),
        "independent process failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn kill_and_reap_process(mut child: std::process::Child) {
    child.kill().expect("abruptly kill test process");
    let output = wait_for_process_output(child, PROCESS_EXIT_TIMEOUT);
    assert!(
        !output.status.success(),
        "killed process unexpectedly succeeded\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn spawn_ready_children(
    root: &std::path::Path,
    coordination: &std::path::Path,
    role: &str,
    count: usize,
) -> Vec<(String, std::process::Child)> {
    let children: Vec<_> = (0..count)
        .map(|index| {
            let id = index.to_string();
            let child = spawn_process_child(root, coordination, role, &id, None);
            (id, child)
        })
        .collect();
    for (id, _) in &children {
        wait_for_process_marker(&process_marker(coordination, "ready", id));
    }
    children
}

#[derive(Clone, Copy)]
enum ProcessIpcSurface {
    Supervisor,
    Operator,
}

enum PreparedProcessIpc {
    Supervisor(crate::ipc::PreparedSupervisor),
    Operator(crate::ipc::PreparedOperator),
}

enum ProcessIpcIngress {
    Supervisor(crate::ipc::SupervisorIngress),
    Operator(crate::ipc::OperatorIngress),
}

fn run_process_ipc_wave<F>(
    root: &std::path::Path,
    surface: ProcessIpcSurface,
    frame: &[u8],
    mut handle: F,
) -> Vec<Vec<u8>>
where
    F: FnMut(ProcessIpcIngress),
{
    use rustix::net::sockopt::{Timeout, set_socket_timeout, socket_peercred, socket_timeout};
    use rustix::net::{
        AddressFamily, SocketAddrUnix, SocketFlags, SocketType, accept_with, bind, listen,
        socket_with,
    };

    use crate::ipc::{PeerPolicy, prepare_operator, prepare_supervisor};

    const CONTENDERS: usize = 6;
    let coordination = tempfile::tempdir().expect("IPC coordination");
    let socket_path = coordination.path().join("listener.sock");
    let listener_address = SocketAddrUnix::new(&socket_path).expect("listener address");
    let listener = socket_with(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .expect("listener socket");
    bind(&listener, &listener_address).expect("listener bind");
    listen(&listener, CONTENDERS as i32).expect("listener listen");
    set_socket_timeout(&listener, Timeout::Recv, Some(PROCESS_IPC_TIMEOUT))
        .expect("bounded listener accept");
    assert_eq!(
        socket_timeout(&listener, Timeout::Recv).expect("listener accept timeout"),
        Some(PROCESS_IPC_TIMEOUT)
    );
    std::fs::write(coordination.path().join("request.bin"), frame).expect("request fixture");

    let children: Vec<_> = (0..CONTENDERS)
        .map(|index| {
            let id = index.to_string();
            let child = spawn_process_child(root, coordination.path(), "ipc-request", &id, None);
            (id, child)
        })
        .collect();
    let prepared: Vec<_> = (0..CONTENDERS)
        .map(|_| {
            let server = accept_with(&listener, SocketFlags::CLOEXEC).expect("accepted client");
            let policy = PeerPolicy::synthetic(socket_peercred(&server).expect("client identity"));
            match surface {
                ProcessIpcSurface::Supervisor => PreparedProcessIpc::Supervisor(
                    prepare_supervisor(server, &policy).expect("prepared supervisor client"),
                ),
                ProcessIpcSurface::Operator => PreparedProcessIpc::Operator(
                    prepare_operator(server, &policy).expect("prepared operator client"),
                ),
            }
        })
        .collect();
    for (id, _) in &children {
        wait_for_process_marker(&process_marker(coordination.path(), "ready", id));
    }
    write_process_marker(&coordination.path().join("gate"), "go");
    for (id, _) in &children {
        wait_for_process_marker(&process_marker(coordination.path(), "sent", id));
    }
    for endpoint in prepared {
        handle(match endpoint {
            PreparedProcessIpc::Supervisor(endpoint) => {
                ProcessIpcIngress::Supervisor(endpoint.receive().expect("supervisor request"))
            }
            PreparedProcessIpc::Operator(endpoint) => {
                ProcessIpcIngress::Operator(endpoint.receive().expect("operator request"))
            }
        });
    }
    for (_, child) in children {
        assert_process_success(child);
    }
    (0..CONTENDERS)
        .map(|index| {
            std::fs::read(process_marker(
                coordination.path(),
                "result",
                &index.to_string(),
            ))
            .expect("child response")
        })
        .collect()
}

fn assert_one_process_commit(responses: &[Vec<u8>], success_type: u16, refusal_type: u16) {
    let mut successes = 0;
    let mut stale = 0;
    for response in responses {
        let message_type = u16::from_be_bytes([response[10], response[11]]);
        if message_type == success_type {
            successes += 1;
        } else {
            assert_eq!(message_type, refusal_type);
            assert!(frame_text(response).contains("\"code\": \"stale_compare_and_set\""));
            stale += 1;
        }
    }
    assert_eq!(successes, 1, "one process request commits");
    assert_eq!(stale, responses.len() - 1, "all losing requests are stale");
}

fn assert_lock_probe_wave<F>(root: &std::path::Path, commit: F)
where
    F: FnOnce(),
{
    const CONTENDERS: usize = 6;
    let coordination = tempfile::tempdir().expect("lock coordination");
    let children = spawn_ready_children(root, coordination.path(), "expect-lock", CONTENDERS);
    write_process_marker(&coordination.path().join("gate"), "go");
    commit();
    for (id, _) in &children {
        let result = process_marker(coordination.path(), "result", id);
        wait_for_process_marker(&result);
        assert_eq!(
            std::fs::read_to_string(result).expect("lock result"),
            "lock"
        );
    }
    for (_, child) in children {
        assert_process_success(child);
    }
}

fn commit_test_registration<S, C, E>(
    authority: &RootAuthority<S, C, E>,
) -> (crate::journal::VerifiedSnapshot, Candidate)
where
    S: RecordSigner,
    C: TrustedClock,
    E: TicketEntropy,
{
    let outcome = authority
        .register(RegisterCommand::new(
            HeadCas::new(0, GENESIS_SHA256.to_owned()),
            candidate("2026-09-03T12:15:00Z"),
        ))
        .expect("register");
    drop(outcome);
    let (_, snapshot) = authority.inspect().expect("registered snapshot");
    let value = match &snapshot.state {
        VerifiedState::CandidateRegistered { candidate, .. } => candidate.as_ref().clone(),
        _ => panic!("registered state"),
    };
    (snapshot, value)
}

fn commit_test_approval<S, C, E>(
    authority: &RootAuthority<S, C, E>,
    registered: &crate::journal::VerifiedSnapshot,
    value: &Candidate,
) -> crate::journal::VerifiedSnapshot
where
    S: RecordSigner,
    C: TrustedClock,
    E: TicketEntropy,
{
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(value, observations()).expect("verified envelope");
    let authentication = authentication(value);
    let outcome = authority
        .approve(
            ApproveCommand::new(
                HeadCas::new(registered.generation, registered.transition_sha256.clone()),
                value.operation_id.clone(),
                value.authorization_nonce.clone(),
                value.envelope_sha256.clone(),
                value.approval_challenge_sha256.clone(),
            ),
            &verified,
            &authentication,
        )
        .expect("approve");
    drop(outcome);
    authority.inspect().expect("approved snapshot").1
}

fn candidate_close_inputs(
    snapshot: &crate::journal::VerifiedSnapshot,
    value: &Candidate,
    session: char,
    authenticated_at: &str,
) -> (CloseCandidateCommand, FreshAttendedAuthentication) {
    let candidate_sha256 = match &snapshot.state {
        VerifiedState::CandidateRegistered {
            candidate_sha256, ..
        } => candidate_sha256,
        _ => panic!("candidate state"),
    };
    let challenge = derive_candidate_close_challenge(
        &snapshot.transition_sha256,
        candidate_sha256,
        &value.approval_challenge_sha256,
    )
    .expect("candidate closure challenge");
    let authentication = FreshAttendedAuthentication::synthetic(
        challenge.clone(),
        digest('e'),
        digest(session),
        authenticated_at.to_owned(),
    );
    (
        CloseCandidateCommand::new(
            HeadCas::new(snapshot.generation, snapshot.transition_sha256.clone()),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            challenge,
        ),
        authentication,
    )
}

fn approval_close_inputs(
    snapshot: &crate::journal::VerifiedSnapshot,
    value: &Candidate,
    session: char,
    authenticated_at: &str,
) -> (CloseApprovalCommand, FreshAttendedAuthentication) {
    let (candidate_sha256, grant_sha256, grant_signature_sha256) = match &snapshot.state {
        VerifiedState::Approved {
            candidate_sha256,
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (candidate_sha256, grant_sha256, grant_signature_sha256),
        _ => panic!("approved state"),
    };
    let challenge = derive_approval_close_challenge(
        &snapshot.transition_sha256,
        candidate_sha256,
        &value.approval_challenge_sha256,
        grant_sha256,
        grant_signature_sha256,
    )
    .expect("approval closure challenge");
    let authentication = FreshAttendedAuthentication::synthetic(
        challenge.clone(),
        digest('e'),
        digest(session),
        authenticated_at.to_owned(),
    );
    (
        CloseApprovalCommand::new(
            HeadCas::new(snapshot.generation, snapshot.transition_sha256.clone()),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            grant_sha256.clone(),
            grant_signature_sha256.clone(),
            challenge,
        ),
        authentication,
    )
}

fn observed_process_store_state(store: &JournalStore) -> &'static str {
    match store.inspect() {
        Ok((Health::Available, snapshot)) if matches!(snapshot.state, VerifiedState::Empty) => {
            "available-empty"
        }
        Ok((Health::RecoveredNonterminal, snapshot))
            if matches!(snapshot.state, VerifiedState::CandidateRegistered { .. }) =>
        {
            "recovered-candidate"
        }
        Ok((Health::RecoveredNonterminal, snapshot))
            if matches!(snapshot.state, VerifiedState::Approved { .. }) =>
        {
            "recovered-approved"
        }
        Ok((Health::RecoveredNonterminal, snapshot))
            if matches!(snapshot.state, VerifiedState::Consumed { .. }) =>
        {
            "recovered-consumed"
        }
        Err(StorageError::Sealed) => "sealed",
        other => panic!("unexpected process store state: {other:?}"),
    }
}

#[test]
fn wp199_independent_process_child() {
    let Ok(role) = std::env::var(PROCESS_CHILD_ROLE) else {
        return;
    };
    if role == "inherited-sender" {
        use rustix::net::{SendFlags, Shutdown, send, shutdown};

        let frame = register_request_frame(0, GENESIS_SHA256, &candidate("2026-09-03T12:15:00Z"));
        let stdin = std::io::stdin();
        assert_eq!(
            send(&stdin, &frame, SendFlags::NOSIGNAL).expect("child request send"),
            frame.len()
        );
        shutdown(&stdin, Shutdown::Write).expect("child write shutdown");
        return;
    }
    let root =
        std::path::PathBuf::from(std::env::var_os(PROCESS_CHILD_ROOT).expect("child journal root"));
    let coordination = std::path::PathBuf::from(
        std::env::var_os(PROCESS_CHILD_COORDINATION).expect("child coordination root"),
    );
    let id = std::env::var(PROCESS_CHILD_ID).expect("child id");
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    match role.as_str() {
        "ipc-request" => {
            use rustix::net::sockopt::{Timeout, set_socket_timeout, socket_timeout};
            use rustix::net::{
                AddressFamily, RecvFlags, SendFlags, Shutdown, SocketAddrUnix, SocketFlags,
                SocketType, connect, recv, send, shutdown, socket_with,
            };

            let address =
                SocketAddrUnix::new(coordination.join("listener.sock")).expect("listener address");
            let client = socket_with(
                AddressFamily::UNIX,
                SocketType::SEQPACKET,
                SocketFlags::CLOEXEC,
                None,
            )
            .expect("client socket");
            set_socket_timeout(&client, Timeout::Recv, Some(PROCESS_IPC_TIMEOUT))
                .expect("bounded response receive");
            assert_eq!(
                socket_timeout(&client, Timeout::Recv).expect("response receive timeout"),
                Some(PROCESS_IPC_TIMEOUT)
            );
            connect(&client, &address).expect("client connect");
            write_process_marker(&process_marker(&coordination, "ready", &id), "ready");
            wait_for_process_marker(&coordination.join("gate"));
            let frame = std::fs::read(coordination.join("request.bin")).expect("request frame");
            assert_eq!(
                send(&client, &frame, SendFlags::NOSIGNAL).expect("request send"),
                frame.len()
            );
            shutdown(&client, Shutdown::Write).expect("request shutdown");
            write_process_marker(&process_marker(&coordination, "sent", &id), "sent");
            let mut response = vec![0_u8; crate::protocol::MAX_FRAME_BYTES];
            let (received, reported) =
                recv(&client, &mut response, RecvFlags::empty()).expect("response receive");
            assert_eq!(received, reported);
            response.truncate(received);
            assert!(!response.is_empty(), "one response packet");
            let mut eof = [0_u8; 1];
            assert_eq!(
                recv(&client, &mut eof, RecvFlags::empty()).expect("response EOF"),
                (0, 0)
            );
            std::fs::write(process_marker(&coordination, "result", &id), response)
                .expect("persist response fixture");
        }
        "race-register" => {
            write_process_marker(&process_marker(&coordination, "ready", &id), "ready");
            wait_for_process_marker(&coordination.join("gate"));
            match open_test_store(&root, public_key) {
                Ok(store) => {
                    let authority = RootAuthority::synthetic(
                        store,
                        SyntheticRecordSigner::from_seed([7; 32]),
                        FixedClock(NOW),
                        FixedEntropy([3; 32]),
                    )
                    .expect("winning child authority");
                    drop(
                        authority
                            .register(RegisterCommand::new(
                                HeadCas::new(0, GENESIS_SHA256.to_owned()),
                                candidate("2026-09-03T12:15:00Z"),
                            ))
                            .expect("winning child registration"),
                    );
                    write_process_marker(&process_marker(&coordination, "result", &id), "winner");
                    park_process_until_release(&coordination, &id);
                }
                Err(OpenError::Lock) => {
                    write_process_marker(&process_marker(&coordination, "result", &id), "lock")
                }
                Err(error) => panic!("unexpected child open error: {error:?}"),
            }
        }
        "expect-lock" => {
            write_process_marker(&process_marker(&coordination, "ready", &id), "ready");
            wait_for_process_marker(&coordination.join("gate"));
            assert_eq!(
                open_test_store(&root, public_key).err(),
                Some(OpenError::Lock)
            );
            write_process_marker(&process_marker(&coordination, "result", &id), "lock");
        }
        "hold-state" => {
            let store = open_test_store(&root, public_key).expect("child store open");
            let expected = std::env::var(PROCESS_CHILD_EXPECTED).expect("expected state");
            assert_eq!(observed_process_store_state(&store), expected);
            write_process_marker(&process_marker(&coordination, "ready", &id), "ready");
            park_process_until_release(&coordination, &id);
        }
        "fault-register" => {
            let store = open_test_store(&root, public_key).expect("fault child store open");
            let authority = RootAuthority::synthetic(
                store,
                SyntheticRecordSigner::from_seed([7; 32]),
                FixedClock(NOW),
                FixedEntropy([3; 32]),
            )
            .expect("fault child authority");
            let cut = std::env::var(PROCESS_CHILD_EXPECTED).expect("fault cut");
            let point = match cut.as_str() {
                "prepublication" => TestFaultPoint::BeforeFirstPublication,
                "partial-artifact" => TestFaultPoint::Publication {
                    ordinal: 1,
                    boundary: TestPublicationBoundary::PartialWrite,
                },
                "complete-transition" => TestFaultPoint::Publication {
                    ordinal: 3,
                    boundary: TestPublicationBoundary::CompleteWrite,
                },
                "postcommit" => TestFaultPoint::PostCommitVerified,
                _ => panic!("unknown fault cut"),
            };
            let ready_coordination = coordination.clone();
            let ready_id = id.clone();
            test_park_at(point, move || {
                write_process_marker(
                    &process_marker(&ready_coordination, "result", &ready_id),
                    "parked",
                );
                write_process_marker(
                    &process_marker(&ready_coordination, "ready", &ready_id),
                    "ready",
                );
            });
            let outcome = authority.register(RegisterCommand::new(
                HeadCas::new(0, GENESIS_SHA256.to_owned()),
                candidate("2026-09-03T12:15:00Z"),
            ));
            panic!(
                "parked publication fault unexpectedly returned: {:?}",
                outcome.test_error()
            );
        }
        _ => panic!("unknown child role"),
    }
}

#[test]
fn inherited_connected_sender_is_rejected_by_per_message_process_identity() {
    use std::process::{Command, Stdio};

    use rustix::net::sockopt::socket_peercred;
    use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};

    use crate::ipc::{IpcError, PeerPolicy, prepare_supervisor};

    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let (directory, store) = empty_test_store(signer.public_key_bytes());
    let authority = RootAuthority::synthetic(store, signer, FixedClock(NOW), FixedEntropy([3; 32]))
        .expect("authority");
    let before = journal_entry_count(directory.path());
    let (client, server) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .expect("socket pair");
    let policy = PeerPolicy::synthetic(socket_peercred(&server).expect("original peer identity"));
    let prepared = prepare_supervisor(server, &policy).expect("prepared supervisor ingress");
    let child = Command::new(std::env::current_exe().expect("current Rust test binary"))
        .arg("--exact")
        .arg("tests::wp199_independent_process_child")
        .arg("--nocapture")
        .env(PROCESS_CHILD_ROLE, "inherited-sender")
        .stdin(Stdio::from(client))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn inherited sender");

    assert_process_success(child);
    assert_eq!(prepared.receive().err(), Some(IpcError::Peer));
    assert_eq!(journal_entry_count(directory.path()), before);
    assert!(matches!(
        authority
            .inspect()
            .expect("unchanged empty journal")
            .1
            .state,
        VerifiedState::Empty
    ));
}

#[test]
fn independent_processes_cannot_share_or_replace_the_live_authority() {
    const CONTENDERS: usize = 6;
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let (race_directory, race_store) = empty_test_store(public_key);
    drop(race_store);
    let coordination = tempfile::tempdir().expect("registration coordination");
    let children = spawn_ready_children(
        race_directory.path(),
        coordination.path(),
        "race-register",
        CONTENDERS,
    );
    write_process_marker(&coordination.path().join("gate"), "go");
    let mut winner = None;
    let mut locked = 0;
    for (id, _) in &children {
        let result = process_marker(coordination.path(), "result", id);
        wait_for_process_marker(&result);
        match std::fs::read_to_string(result)
            .expect("registration result")
            .as_str()
        {
            "winner" => {
                assert!(winner.replace(id.clone()).is_none(), "one process winner");
            }
            "lock" => locked += 1,
            result => panic!("unexpected registration result: {result}"),
        }
    }
    assert_eq!(locked, CONTENDERS - 1);
    write_process_marker(
        &process_marker(
            coordination.path(),
            "release",
            winner.as_deref().expect("registration winner"),
        ),
        "release",
    );
    for (_, child) in children {
        assert_process_success(child);
    }
    let raced_store = reopen_test_store(race_directory.path(), public_key);
    assert_eq!(
        observed_process_store_state(&raced_store),
        "recovered-candidate"
    );
    drop(raced_store);

    let (directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("live parent authority");
    let (registered, value) = commit_test_registration(&authority);
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified envelope");
    let attended = authentication(&value);
    assert_lock_probe_wave(directory.path(), || {
        drop(
            authority
                .approve(
                    ApproveCommand::new(
                        HeadCas::new(registered.generation, registered.transition_sha256.clone()),
                        value.operation_id.clone(),
                        value.authorization_nonce.clone(),
                        value.envelope_sha256.clone(),
                        value.approval_challenge_sha256.clone(),
                    ),
                    &verified,
                    &attended,
                )
                .expect("parent-only approval"),
        );
    });
    let (_, approved) = authority.inspect().expect("approved state");
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    assert_lock_probe_wave(directory.path(), || {
        drop(
            authority
                .consume(ConsumeCommand::new(
                    HeadCas::new(approved.generation, approved.transition_sha256.clone()),
                    value.operation_id.clone(),
                    value.authorization_nonce.clone(),
                    grant_sha256,
                    grant_signature_sha256,
                ))
                .expect("parent-only consume"),
        );
    });
    let (_, consumed) = authority.inspect().expect("consumed state");
    assert!(matches!(consumed.state, VerifiedState::Consumed { .. }));
    let ticket_count = std::fs::read_dir(directory.path().join("objects/leaves"))
        .expect("leaf inventory")
        .map(|entry| std::fs::read(entry.expect("leaf entry").path()).expect("leaf bytes"))
        .filter(|bytes| ExecutionTicket::decode(bytes).is_ok())
        .count();
    assert_eq!(ticket_count, 1, "one execution ticket was minted");
}

#[test]
fn independent_process_clients_race_one_registration_approval_consume_and_ticket() {
    use crate::ipc::{OperatorIngress, SupervisorIngress};

    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let (directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        signer,
        SequenceClock::new([NOW, NOW, NOW]),
        SequenceEntropy::new([Ok([3; 32]), Ok([4; 32])]),
    )
    .expect("authority");

    let offered = candidate("2026-09-03T12:15:00Z");
    let registration_responses = run_process_ipc_wave(
        directory.path(),
        ProcessIpcSurface::Supervisor,
        &register_request_frame(0, GENESIS_SHA256, &offered),
        |ingress| match ingress {
            ProcessIpcIngress::Supervisor(SupervisorIngress::Request {
                request: SupervisorRequest::Register(request),
                reply,
            }) => authority
                .register(request.into_command())
                .attempt(reply)
                .expect("registration response"),
            _ => panic!("registration ingress"),
        },
    );
    assert_one_process_commit(
        &registration_responses,
        SUPERVISOR_REGISTER_SUCCESS,
        SUPERVISOR_REFUSAL,
    );
    let registered = authority.inspect().expect("registered").1;
    assert_eq!(registered.generation, 1);
    let value = match &registered.state {
        VerifiedState::CandidateRegistered { candidate, .. } => candidate.as_ref().clone(),
        _ => panic!("registered state"),
    };

    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified envelope");
    let attended = authentication(&value);
    let approval_responses = run_process_ipc_wave(
        directory.path(),
        ProcessIpcSurface::Operator,
        &approve_request_frame(&registered, &value),
        |ingress| match ingress {
            ProcessIpcIngress::Operator(OperatorIngress::Request {
                request: crate::protocol::OperatorRequest::Approve(request),
                reply,
            }) => authority
                .approve(request.into_command(), &verified, &attended)
                .attempt(reply)
                .expect("approval response"),
            _ => panic!("approval ingress"),
        },
    );
    assert_one_process_commit(
        &approval_responses,
        OPERATOR_APPROVE_SUCCESS,
        OPERATOR_REFUSAL,
    );
    let approved = authority.inspect().expect("approved").1;
    assert_eq!(approved.generation, 2);

    let consume_responses = run_process_ipc_wave(
        directory.path(),
        ProcessIpcSurface::Supervisor,
        &consume_request_frame(&approved, &value),
        |ingress| match ingress {
            ProcessIpcIngress::Supervisor(SupervisorIngress::Request {
                request: SupervisorRequest::Consume(request),
                reply,
            }) => authority
                .consume(request.into_command())
                .attempt(reply)
                .expect("consume response"),
            _ => panic!("consume ingress"),
        },
    );
    assert_one_process_commit(
        &consume_responses,
        SUPERVISOR_CONSUME_SUCCESS,
        SUPERVISOR_REFUSAL,
    );
    let consumed = authority.inspect().expect("consumed").1;
    assert_eq!(consumed.generation, 3);
    assert!(matches!(consumed.state, VerifiedState::Consumed { .. }));

    let ticket_count = std::fs::read_dir(directory.path().join("objects/leaves"))
        .expect("leaf inventory")
        .map(|entry| std::fs::read(entry.expect("leaf entry").path()).expect("leaf bytes"))
        .filter(|bytes| ExecutionTicket::decode(bytes).is_ok())
        .count();
    assert_eq!(ticket_count, 1, "exactly one execution ticket was minted");
}

fn assert_killed_holder_reopens_as(root: &std::path::Path, public_key: [u8; 32], expected: &str) {
    let coordination = tempfile::tempdir().expect("kill coordination");
    let child = spawn_process_child(root, coordination.path(), "hold-state", "0", Some(expected));
    wait_for_process_marker(&process_marker(coordination.path(), "ready", "0"));
    kill_and_reap_process(child);
    let reopened = reopen_test_store(root, public_key);
    assert_eq!(observed_process_store_state(&reopened), expected);
}

#[test]
fn abrupt_process_death_reopens_clean_candidate_approved_consumed_and_corrupt_states() {
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt;

    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let (clean_directory, clean_store) = empty_test_store(public_key);
    drop(clean_store);
    assert_killed_holder_reopens_as(clean_directory.path(), public_key, "available-empty");

    let (candidate_directory, candidate_store) = empty_test_store(public_key);
    let candidate_authority = RootAuthority::synthetic(
        candidate_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock(NOW),
        FixedEntropy([3; 32]),
    )
    .expect("candidate authority");
    let (candidate_snapshot, _candidate_value) = commit_test_registration(&candidate_authority);
    drop(candidate_authority);
    assert_killed_holder_reopens_as(
        candidate_directory.path(),
        public_key,
        "recovered-candidate",
    );

    let (approved_directory, approved_store) = empty_test_store(public_key);
    let approved_authority = RootAuthority::synthetic(
        approved_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("approved authority");
    let (registered, approved_value) = commit_test_registration(&approved_authority);
    let _approved = commit_test_approval(&approved_authority, &registered, &approved_value);
    drop(approved_authority);
    assert_killed_holder_reopens_as(approved_directory.path(), public_key, "recovered-approved");

    let (consumed_directory, consumed_store) = empty_test_store(public_key);
    let consumed_authority = RootAuthority::synthetic(
        consumed_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("consumed authority");
    let (registered, consumed_value) = commit_test_registration(&consumed_authority);
    let approved = commit_test_approval(&consumed_authority, &registered, &consumed_value);
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    drop(
        consumed_authority
            .consume(ConsumeCommand::new(
                HeadCas::new(approved.generation, approved.transition_sha256),
                consumed_value.operation_id,
                consumed_value.authorization_nonce,
                grant_sha256,
                grant_signature_sha256,
            ))
            .expect("consume"),
    );
    drop(consumed_authority);
    assert_killed_holder_reopens_as(consumed_directory.path(), public_key, "recovered-consumed");

    let candidate_sha256 = match &candidate_snapshot.state {
        VerifiedState::CandidateRegistered {
            candidate_sha256, ..
        } => candidate_sha256,
        _ => panic!("candidate state"),
    };
    std::fs::set_permissions(
        candidate_directory
            .path()
            .join("objects/leaves")
            .join(candidate_sha256),
        Permissions::from_mode(0o640),
    )
    .expect("corrupt retained object mode");
    assert_killed_holder_reopens_as(candidate_directory.path(), public_key, "sealed");
}

#[test]
fn abrupt_process_death_at_publication_cuts_reopens_conservatively() {
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();
    for (cut, expected) in [
        ("prepublication", "available-empty"),
        ("partial-artifact", "sealed"),
        ("complete-transition", "recovered-candidate"),
        ("postcommit", "recovered-candidate"),
    ] {
        let (directory, store) = empty_test_store(public_key);
        drop(store);
        let coordination = tempfile::tempdir().expect("fault coordination");
        let child = spawn_process_child(
            directory.path(),
            coordination.path(),
            "fault-register",
            "0",
            Some(cut),
        );
        wait_for_process_marker(&process_marker(coordination.path(), "ready", "0"));
        assert_eq!(
            std::fs::read_to_string(process_marker(coordination.path(), "result", "0"))
                .expect("fault result"),
            "parked"
        );
        kill_and_reap_process(child);
        let reopened = reopen_test_store(directory.path(), public_key);
        assert_eq!(observed_process_store_state(&reopened), expected, "{cut}");
    }
}

#[test]
fn transition_signer_failures_after_artifact_publication_seal_current_and_reopened_authorities() {
    let pinned_public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let (register_directory, register_store) = empty_test_store(pinned_public_key);
    let register_authority = RootAuthority::synthetic(
        register_store,
        FailingTransitionSigner::new(FailingTransition::CandidateRegistered),
        FixedClock(NOW),
        FixedEntropy([3; 32]),
    )
    .expect("register authority");
    let before = journal_entry_count(register_directory.path());
    let register = register_authority.register(RegisterCommand::new(
        HeadCas::new(0, GENESIS_SHA256.to_owned()),
        candidate("2026-09-03T12:15:00Z"),
    ));
    assert_eq!(register.test_error(), Some(CommitError::Unavailable));
    drop(register);
    assert!(journal_entry_count(register_directory.path()) > before);
    assert!(matches!(
        register_authority.inspect(),
        Err(StorageError::Sealed)
    ));
    drop(register_authority);
    assert!(matches!(
        reopen_test_store(register_directory.path(), pinned_public_key).inspect(),
        Err(StorageError::Sealed)
    ));

    let (approve_directory, approve_store) = empty_test_store(pinned_public_key);
    let approve_authority = RootAuthority::synthetic(
        approve_store,
        FailingTransitionSigner::new(FailingTransition::Approved),
        FixedClock(NOW),
        FixedEntropy([3; 32]),
    )
    .expect("approve authority");
    let (registered, value) = commit_test_registration(&approve_authority);
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified envelope");
    let attended = authentication(&value);
    let before = journal_entry_count(approve_directory.path());
    let approve = approve_authority.approve(
        ApproveCommand::new(
            HeadCas::new(registered.generation, registered.transition_sha256),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            value.approval_challenge_sha256.clone(),
        ),
        &verified,
        &attended,
    );
    assert_eq!(approve.test_error(), Some(CommitError::Unavailable));
    drop(approve);
    assert!(journal_entry_count(approve_directory.path()) > before);
    assert!(matches!(
        approve_authority.inspect(),
        Err(StorageError::Sealed)
    ));
    drop(approve_authority);
    assert!(matches!(
        reopen_test_store(approve_directory.path(), pinned_public_key).inspect(),
        Err(StorageError::Sealed)
    ));

    let (consume_directory, consume_store) = empty_test_store(pinned_public_key);
    let consume_authority = RootAuthority::synthetic(
        consume_store,
        FailingTransitionSigner::new(FailingTransition::Consumed),
        FixedClock(NOW),
        FixedEntropy([3; 32]),
    )
    .expect("consume authority");
    let (registered, value) = commit_test_registration(&consume_authority);
    let approved = commit_test_approval(&consume_authority, &registered, &value);
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    let before = journal_entry_count(consume_directory.path());
    let consume = consume_authority.consume(ConsumeCommand::new(
        HeadCas::new(approved.generation, approved.transition_sha256),
        value.operation_id,
        value.authorization_nonce,
        grant_sha256,
        grant_signature_sha256,
    ));
    assert_eq!(consume.test_error(), Some(CommitError::Unavailable));
    drop(consume);
    assert!(journal_entry_count(consume_directory.path()) > before);
    assert!(matches!(
        consume_authority.inspect(),
        Err(StorageError::Sealed)
    ));
    drop(consume_authority);
    assert!(matches!(
        reopen_test_store(consume_directory.path(), pinned_public_key).inspect(),
        Err(StorageError::Sealed)
    ));
}

#[test]
fn transition_signer_failures_before_closure_publication_leave_predecessor_readable() {
    let pinned_public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let (candidate_directory, candidate_store) = empty_test_store(pinned_public_key);
    let candidate_authority = RootAuthority::synthetic(
        candidate_store,
        FailingTransitionSigner::new(FailingTransition::CandidateExpired),
        SequenceClock::new([NOW, "2026-09-03T12:15:00Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("candidate authority");
    let (registered, value) = commit_test_registration(&candidate_authority);
    let (command, attended) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:14:30Z");
    let before = journal_entry_count(candidate_directory.path());
    let close = candidate_authority.close_candidate(command, &attended);
    assert_eq!(close.test_error(), Some(CommitError::Signer));
    drop(close);
    assert_eq!(journal_entry_count(candidate_directory.path()), before);
    assert!(matches!(
        candidate_authority
            .inspect()
            .expect("readable candidate")
            .1
            .state,
        VerifiedState::CandidateRegistered { .. }
    ));

    let (approval_directory, approval_store) = empty_test_store(pinned_public_key);
    let approval_authority = RootAuthority::synthetic(
        approval_store,
        FailingTransitionSigner::new(FailingTransition::ApprovalExpired),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:09:30Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("approval authority");
    let (registered, value) = commit_test_registration(&approval_authority);
    let approved = commit_test_approval(&approval_authority, &registered, &value);
    let (command, attended) = approval_close_inputs(&approved, &value, '0', "2026-09-03T12:09:00Z");
    let before = journal_entry_count(approval_directory.path());
    let close = approval_authority.close_approval(command, &attended);
    assert_eq!(close.test_error(), Some(CommitError::Signer));
    drop(close);
    assert_eq!(journal_entry_count(approval_directory.path()), before);
    assert!(matches!(
        approval_authority
            .inspect()
            .expect("readable approval")
            .1
            .state,
        VerifiedState::Approved { .. }
    ));
}

#[test]
fn failure_precedence_is_policy_uniqueness_then_time_entropy_and_signer() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let wrong = Arc::new(AtomicBool::new(true));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        ToggleKeySigner::new(Arc::clone(&wrong)),
        FixedClock("invalid-clock"),
        FixedEntropy([3; 32]),
    )
    .expect("register authority");
    let register = authority.register(RegisterCommand::new(
        HeadCas::new(0, GENESIS_SHA256.to_owned()),
        candidate("2026-09-03T12:15:00Z"),
    ));
    assert_eq!(register.test_error(), Some(CommitError::Clock));

    let wrong = Arc::new(AtomicBool::new(false));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        ToggleKeySigner::new(Arc::clone(&wrong)),
        SequenceClock::new([NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("approve authority");
    let (registered, value) = commit_test_registration(&authority);
    wrong.store(true, Ordering::SeqCst);
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified");
    let approve = authority.approve(
        ApproveCommand::new(
            HeadCas::new(registered.generation, registered.transition_sha256),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            value.approval_challenge_sha256.clone(),
        ),
        &verified,
        &authentication(&value),
    );
    assert_eq!(approve.test_error(), Some(CommitError::Clock));

    let wrong = Arc::new(AtomicBool::new(false));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        ToggleKeySigner::new(Arc::clone(&wrong)),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("consume authority");
    let (registered, value) = commit_test_registration(&authority);
    let approved = commit_test_approval(&authority, &registered, &value);
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    wrong.store(true, Ordering::SeqCst);
    let consume = authority.consume(ConsumeCommand::new(
        HeadCas::new(approved.generation, approved.transition_sha256),
        value.operation_id,
        value.authorization_nonce,
        grant_sha256,
        grant_signature_sha256,
    ));
    assert_eq!(consume.test_error(), Some(CommitError::Clock));

    let wrong = Arc::new(AtomicBool::new(false));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        ToggleKeySigner::new(Arc::clone(&wrong)),
        SequenceClock::new([NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("candidate closure authority");
    let (registered, value) = commit_test_registration(&authority);
    let (command, attended) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:04:30Z");
    wrong.store(true, Ordering::SeqCst);
    let close = authority.close_candidate(command, &attended);
    assert_eq!(close.test_error(), Some(CommitError::Clock));

    let wrong = Arc::new(AtomicBool::new(false));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        ToggleKeySigner::new(Arc::clone(&wrong)),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("approval closure authority");
    let (registered, value) = commit_test_registration(&authority);
    let approved = commit_test_approval(&authority, &registered, &value);
    let (command, attended) = approval_close_inputs(&approved, &value, '0', "2026-09-03T12:04:30Z");
    wrong.store(true, Ordering::SeqCst);
    let close = authority.close_approval(command, &attended);
    assert_eq!(close.test_error(), Some(CommitError::Clock));

    let wrong = Arc::new(AtomicBool::new(false));
    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        ToggleKeySigner::new(Arc::clone(&wrong)),
        FixedClock(NOW),
        SequenceEntropy::new([Ok([3; 32]), Err(())]),
    )
    .expect("entropy authority");
    let (registered, value) = commit_test_registration(&authority);
    let approved = commit_test_approval(&authority, &registered, &value);
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    wrong.store(true, Ordering::SeqCst);
    let consume = authority.consume(ConsumeCommand::new(
        HeadCas::new(approved.generation, approved.transition_sha256),
        value.operation_id,
        value.authorization_nonce,
        grant_sha256,
        grant_signature_sha256,
    ));
    assert_eq!(consume.test_error(), Some(CommitError::Entropy));
}

#[test]
fn verified_envelope_and_session_replays_refuse_before_clock_or_signer_capabilities() {
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("authority");
    let (registered, value) = commit_test_registration(&authority);
    let mut different = value.clone();
    different.target_selection_sha256 = digest('0');
    let mismatched = RootVerifiedPreparedEnvelope::synthetic(&different, observations())
        .expect("mismatched envelope");
    let approve = authority.approve(
        ApproveCommand::new(
            HeadCas::new(registered.generation, registered.transition_sha256),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            value.approval_challenge_sha256.clone(),
        ),
        &mismatched,
        &authentication(&value),
    );
    assert_eq!(approve.test_error(), Some(CommitError::Policy));

    let (_directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("approval replay authority");
    let (registered, value) = commit_test_registration(&authority);
    let approved = commit_test_approval(&authority, &registered, &value);
    let (command, attended) = approval_close_inputs(&approved, &value, 'f', "2026-09-03T12:09:00Z");
    let close = authority.close_approval(command, &attended);
    assert_eq!(close.test_error(), Some(CommitError::Collision));

    let (directory, store) = empty_test_store(public_key);
    let authority = RootAuthority::synthetic(
        store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:09:30Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("historical session authority");
    let (registered, value) = commit_test_registration(&authority);
    let approved = commit_test_approval(&authority, &registered, &value);
    let (command, attended) = approval_close_inputs(&approved, &value, '0', "2026-09-03T12:09:00Z");
    drop(
        authority
            .close_approval(command, &attended)
            .expect("terminal approval closure"),
    );
    drop(authority);

    let recovered = RootAuthority::synthetic(
        reopen_test_store(directory.path(), public_key),
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new(["2026-09-03T12:09:31Z"]),
        FixedEntropy([4; 32]),
    )
    .expect("new terminal authority");
    let terminal = recovered.inspect().expect("terminal state").1;
    let mut next = candidate("2026-09-03T12:15:00Z");
    next.operation_id = digest('6');
    next.authorization_nonce = digest('7');
    next.envelope_sha256 = digest('8');
    let registered = recovered
        .register(RegisterCommand::new(
            HeadCas::new(terminal.generation, terminal.transition_sha256),
            next,
        ))
        .expect("second registration");
    drop(registered);
    let snapshot = recovered.inspect().expect("second candidate").1;
    let next = match &snapshot.state {
        VerifiedState::CandidateRegistered { candidate, .. } => candidate.as_ref().clone(),
        _ => panic!("candidate state"),
    };
    let (command, attended) = candidate_close_inputs(&snapshot, &next, 'f', "2026-09-03T12:14:30Z");
    let close = recovered.close_candidate(command, &attended);
    assert_eq!(close.test_error(), Some(CommitError::Collision));
}

fn register_request_frame(
    expected_generation: u64,
    expected_transition_sha256: &str,
    value: &Candidate,
) -> Vec<u8> {
    let payload = object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-register-request.v1"),
        ),
        (
            "expectedGeneration",
            FieldValue::Integer(expected_generation),
        ),
        (
            "expectedTransitionSha256",
            FieldValue::String(expected_transition_sha256),
        ),
        ("operationId", FieldValue::String(&value.operation_id)),
        (
            "authorizationNonce",
            FieldValue::String(&value.authorization_nonce),
        ),
        (
            "targetFingerprint",
            FieldValue::String(&value.target_fingerprint),
        ),
        (
            "targetSelectionSha256",
            FieldValue::String(&value.target_selection_sha256),
        ),
        ("envelopeSha256", FieldValue::String(&value.envelope_sha256)),
        (
            "envelopeExpiresAt",
            FieldValue::String(&value.envelope_expires_at),
        ),
        (
            "externalExclusiveWindowGeneration",
            FieldValue::Integer(value.external_exclusive_window_generation),
        ),
        (
            "externalExclusiveWindowEvidenceSha256",
            FieldValue::String(&value.external_exclusive_window_evidence_sha256),
        ),
        (
            "externalExclusiveWindowExpiresAt",
            FieldValue::String(&value.external_exclusive_window_expires_at),
        ),
        (
            "officialSourceEvidenceSha256",
            FieldValue::String(&value.official_source_evidence_sha256),
        ),
        (
            "nativeRuntimeIdentitySha256",
            FieldValue::String(&value.native_runtime_identity_sha256),
        ),
        (
            "childSandboxPolicySha256",
            FieldValue::String(&value.child_sandbox_policy_sha256),
        ),
        (
            "phaseExecTopologyPolicySha256",
            FieldValue::String(&value.phase_exec_topology_policy_sha256),
        ),
        (
            "childCgroupPolicySha256",
            FieldValue::String(&value.child_cgroup_policy_sha256),
        ),
        (
            "applyInvocationEvidenceSha256",
            FieldValue::String(&value.apply_invocation_evidence_sha256),
        ),
    ])
    .expect("register request payload");
    encode_frame(crate::protocol::SUPERVISOR_REGISTER, &payload).expect("register request frame")
}

fn consume_request_frame(
    snapshot: &crate::journal::VerifiedSnapshot,
    value: &Candidate,
) -> Vec<u8> {
    let (grant_sha256, grant_signature_sha256) = match &snapshot.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256, grant_signature_sha256),
        _ => panic!("approved state"),
    };
    let payload = object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-consume-request.v1"),
        ),
        (
            "expectedGeneration",
            FieldValue::Integer(snapshot.generation),
        ),
        (
            "expectedTransitionSha256",
            FieldValue::String(&snapshot.transition_sha256),
        ),
        ("operationId", FieldValue::String(&value.operation_id)),
        (
            "authorizationNonce",
            FieldValue::String(&value.authorization_nonce),
        ),
        ("approvalGrantSha256", FieldValue::String(grant_sha256)),
        (
            "approvalGrantSignatureSha256",
            FieldValue::String(grant_signature_sha256),
        ),
    ])
    .expect("consume request payload");
    encode_frame(SUPERVISOR_CONSUME, &payload).expect("consume request frame")
}

fn approve_request_frame(
    snapshot: &crate::journal::VerifiedSnapshot,
    value: &Candidate,
) -> Vec<u8> {
    let payload = object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-approve-request.v1"),
        ),
        (
            "expectedGeneration",
            FieldValue::Integer(snapshot.generation),
        ),
        (
            "expectedTransitionSha256",
            FieldValue::String(&snapshot.transition_sha256),
        ),
        ("operationId", FieldValue::String(&value.operation_id)),
        (
            "authorizationNonce",
            FieldValue::String(&value.authorization_nonce),
        ),
        ("envelopeSha256", FieldValue::String(&value.envelope_sha256)),
        (
            "actionChallengeSha256",
            FieldValue::String(&value.approval_challenge_sha256),
        ),
    ])
    .expect("approve request payload");
    encode_frame(OPERATOR_APPROVE, &payload).expect("approve request frame")
}

fn status_request_frame(operation_id: &str) -> Vec<u8> {
    let payload = object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-status-request.v1"),
        ),
        ("operationId", FieldValue::String(operation_id)),
    ])
    .expect("status request payload");
    encode_frame(SUPERVISOR_STATUS, &payload).expect("status request frame")
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

    let authority = RootAuthority::synthetic(store, signer, FixedClock(NOW), FixedEntropy([3; 32]))
        .expect("authority open");
    let committed = authority
        .register(RegisterCommand::new(
            HeadCas::new(0, GENESIS_SHA256.to_owned()),
            candidate("2026-09-03T12:15:00Z"),
        ))
        .expect("direct-final publication");
    assert_eq!(committed.test_snapshot().0, "candidate_registered");
    drop(committed);
    let (_, registered) = authority.inspect().expect("registered inventory");
    let candidate_sha256 = match &registered.state {
        VerifiedState::CandidateRegistered {
            candidate_sha256, ..
        } => candidate_sha256.clone(),
        _ => panic!("registered state"),
    };
    assert!(matches!(
        registered.state,
        VerifiedState::CandidateRegistered { .. }
    ));
    fs::set_permissions(
        root.join("objects/leaves").join(&candidate_sha256),
        Permissions::from_mode(0o640),
    )
    .expect("corrupt mode");
    assert_eq!(authority.inspect(), Err(StorageError::Unavailable));
    assert_eq!(authority.inspect(), Err(StorageError::Sealed));
}

#[test]
fn locked_typed_authority_commits_register_approve_consume_and_digest_only_status() {
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
    let authority = RootAuthority::synthetic(store, signer, FixedClock(NOW), FixedEntropy([3; 32]))
        .expect("authority open");

    let registered = authority
        .register(RegisterCommand::new(
            HeadCas::new(0, GENESIS_SHA256.to_owned()),
            candidate("2026-09-03T12:15:00Z"),
        ))
        .expect("register");
    assert_eq!(registered.test_snapshot().0, "candidate_registered");
    drop(registered);
    let (_, registered) = authority.inspect().expect("registered status");
    let registered_head = HeadCas::new(registered.generation, registered.transition_sha256.clone());
    let registered_candidate = match &registered.state {
        VerifiedState::CandidateRegistered { candidate, .. } => candidate.as_ref().clone(),
        _ => panic!("registered state"),
    };
    let verified = RootVerifiedPreparedEnvelope::synthetic(&registered_candidate, observations())
        .expect("verified envelope");
    let auth = authentication(&registered_candidate);
    let approved = authority
        .approve(
            ApproveCommand::new(
                registered_head,
                registered_candidate.operation_id.clone(),
                registered_candidate.authorization_nonce.clone(),
                registered_candidate.envelope_sha256.clone(),
                registered_candidate.approval_challenge_sha256.clone(),
            ),
            &verified,
            &auth,
        )
        .expect("approve");
    assert_eq!(approved.test_snapshot().0, "approved");
    drop(approved);

    let (_, approved) = authority.inspect().expect("approved status");
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    let consumed = authority
        .consume(ConsumeCommand::new(
            HeadCas::new(approved.generation, approved.transition_sha256.clone()),
            registered_candidate.operation_id.clone(),
            registered_candidate.authorization_nonce.clone(),
            grant_sha256,
            grant_signature_sha256,
        ))
        .expect("consume");
    assert_eq!(consumed.test_snapshot().0, "consumed");
    drop(consumed);

    let status = authority
        .status(StatusCommand::new(registered_candidate.operation_id))
        .expect("status");
    assert_eq!(status.test_snapshot().0, "consumed");
}

#[test]
fn clock_rollback_refuses_before_publication_for_all_five_mutation_paths() {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);

    let (approval_directory, approval_store) = empty_test_store(signer.public_key_bytes());
    let approval_authority = RootAuthority::synthetic(
        approval_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("approval authority");
    let (registered, value) = commit_test_registration(&approval_authority);
    let before = journal_entry_count(approval_directory.path());
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified envelope");
    let approval = approval_authority.approve(
        ApproveCommand::new(
            HeadCas::new(registered.generation, registered.transition_sha256.clone()),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            value.envelope_sha256.clone(),
            value.approval_challenge_sha256.clone(),
        ),
        &verified,
        &authentication(&value),
    );
    assert_eq!(approval.test_error(), Some(CommitError::Clock));
    drop(approval);
    assert_eq!(journal_entry_count(approval_directory.path()), before);
    assert!(matches!(
        approval_authority
            .inspect()
            .expect("readable candidate")
            .1
            .state,
        VerifiedState::CandidateRegistered { .. }
    ));

    let (consume_directory, consume_store) = empty_test_store(signer.public_key_bytes());
    let consume_authority = RootAuthority::synthetic(
        consume_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("consume authority");
    let (registered, value) = commit_test_registration(&consume_authority);
    let approved = commit_test_approval(&consume_authority, &registered, &value);
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    let before = journal_entry_count(consume_directory.path());
    let consume = consume_authority.consume(ConsumeCommand::new(
        HeadCas::new(approved.generation, approved.transition_sha256.clone()),
        value.operation_id.clone(),
        value.authorization_nonce.clone(),
        grant_sha256,
        grant_signature_sha256,
    ));
    assert_eq!(consume.test_error(), Some(CommitError::Clock));
    drop(consume);
    assert_eq!(journal_entry_count(consume_directory.path()), before);
    assert!(matches!(
        consume_authority.inspect().expect("readable grant").1.state,
        VerifiedState::Approved { .. }
    ));

    let (candidate_directory, candidate_store) = empty_test_store(signer.public_key_bytes());
    let candidate_authority = RootAuthority::synthetic(
        candidate_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("candidate closure authority");
    let (registered, value) = commit_test_registration(&candidate_authority);
    let (command, authentication) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:04:30Z");
    let before = journal_entry_count(candidate_directory.path());
    let closure = candidate_authority.close_candidate(command, &authentication);
    assert_eq!(closure.test_error(), Some(CommitError::Clock));
    drop(closure);
    assert_eq!(journal_entry_count(candidate_directory.path()), before);
    assert!(matches!(
        candidate_authority
            .inspect()
            .expect("readable candidate")
            .1
            .state,
        VerifiedState::CandidateRegistered { .. }
    ));

    let (grant_directory, grant_store) = empty_test_store(signer.public_key_bytes());
    let grant_authority = RootAuthority::synthetic(
        grant_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:04:59Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("grant closure authority");
    let (registered, value) = commit_test_registration(&grant_authority);
    let approved = commit_test_approval(&grant_authority, &registered, &value);
    let (command, authentication) =
        approval_close_inputs(&approved, &value, '0', "2026-09-03T12:04:30Z");
    let before = journal_entry_count(grant_directory.path());
    let closure = grant_authority.close_approval(command, &authentication);
    assert_eq!(closure.test_error(), Some(CommitError::Clock));
    drop(closure);
    assert_eq!(journal_entry_count(grant_directory.path()), before);
    assert!(matches!(
        grant_authority
            .inspect()
            .expect("readable approval")
            .1
            .state,
        VerifiedState::Approved { .. }
    ));

    let (register_directory, register_store) = empty_test_store(signer.public_key_bytes());
    let terminal_authority = RootAuthority::synthetic(
        register_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, "2026-09-03T12:15:00Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("terminal authority");
    let (registered, value) = commit_test_registration(&terminal_authority);
    let (command, authentication) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:14:30Z");
    let closed = terminal_authority
        .close_candidate(command, &authentication)
        .expect("terminal closure");
    drop(closed);
    drop(terminal_authority);
    let reopened = RootAuthority::synthetic(
        reopen_test_store(register_directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new(["2026-09-03T12:14:59Z"]),
        FixedEntropy([4; 32]),
    )
    .expect("reopened terminal authority");
    let before = journal_entry_count(register_directory.path());
    let mut next_candidate = candidate("2026-09-03T12:30:00Z");
    next_candidate.operation_id = digest('6');
    next_candidate.authorization_nonce = digest('7');
    next_candidate.envelope_sha256 = digest('8');
    let register = reopened.register(RegisterCommand::new(
        HeadCas::new(
            2,
            reopened
                .inspect()
                .expect("terminal snapshot")
                .1
                .transition_sha256,
        ),
        next_candidate,
    ));
    assert_eq!(register.test_error(), Some(CommitError::Clock));
    drop(register);
    assert_eq!(journal_entry_count(register_directory.path()), before);
    assert!(matches!(
        reopened.inspect().expect("readable terminal").1.state,
        VerifiedState::CandidateExpired { .. }
    ));
}

#[test]
fn closure_cutoff_minus_one_refuses_without_sealing_and_exact_cutoff_commits() {
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let (candidate_directory, candidate_store) = empty_test_store(signer.public_key_bytes());
    let candidate_authority = RootAuthority::synthetic(
        candidate_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, "2026-09-03T12:14:59Z", "2026-09-03T12:15:00Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("candidate authority");
    let (registered, value) = commit_test_registration(&candidate_authority);
    let before = journal_entry_count(candidate_directory.path());
    let (command, authentication) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:14:30Z");
    let early = candidate_authority.close_candidate(command, &authentication);
    assert_eq!(early.test_error(), Some(CommitError::NotExpired));
    drop(early);
    assert_eq!(journal_entry_count(candidate_directory.path()), before);
    assert_eq!(
        candidate_authority
            .status(StatusCommand::new(value.operation_id.clone()))
            .expect("readable candidate")
            .test_availability(),
        Some("available")
    );
    let (command, authentication) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:14:30Z");
    let exact = candidate_authority
        .close_candidate(command, &authentication)
        .expect("candidate exact cutoff");
    assert_eq!(exact.test_snapshot().0, "candidate_expired");
    drop(exact);

    let (approval_directory, approval_store) = empty_test_store(signer.public_key_bytes());
    let approval_authority = RootAuthority::synthetic(
        approval_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, "2026-09-03T12:09:29Z", "2026-09-03T12:09:30Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("approval authority");
    let (registered, value) = commit_test_registration(&approval_authority);
    let approved = commit_test_approval(&approval_authority, &registered, &value);
    let before = journal_entry_count(approval_directory.path());
    let (command, authentication) =
        approval_close_inputs(&approved, &value, '0', "2026-09-03T12:09:00Z");
    let early = approval_authority.close_approval(command, &authentication);
    assert_eq!(early.test_error(), Some(CommitError::NotExpired));
    drop(early);
    assert_eq!(journal_entry_count(approval_directory.path()), before);
    assert_eq!(
        approval_authority
            .status(StatusCommand::new(value.operation_id.clone()))
            .expect("readable approval")
            .test_availability(),
        Some("available")
    );
    let (command, authentication) =
        approval_close_inputs(&approved, &value, '0', "2026-09-03T12:09:00Z");
    let exact = approval_authority
        .close_approval(command, &authentication)
        .expect("approval exact cutoff");
    assert_eq!(exact.test_snapshot().0, "approval_expired");
}

#[test]
fn incarnation_is_drawn_once_at_open_collisions_refuse_and_recovery_is_process_wide() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let (directory, store) = empty_test_store(signer.public_key_bytes());
    let first = RootAuthority::synthetic(
        store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, "2026-09-03T12:15:00Z"]),
        FixedEntropy([3; 32]),
    )
    .expect("first authority");
    let (registered, first_candidate) = commit_test_registration(&first);
    let (command, authentication) =
        candidate_close_inputs(&registered, &first_candidate, '0', "2026-09-03T12:14:30Z");
    drop(
        first
            .close_candidate(command, &authentication)
            .expect("first terminal closure"),
    );
    drop(first);

    let collision_draws = Arc::new(AtomicUsize::new(0));
    let collision = RootAuthority::synthetic(
        reopen_test_store(directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock("2026-09-03T12:15:00Z"),
        CountingEntropy {
            calls: Arc::clone(&collision_draws),
        },
    );
    assert!(matches!(collision, Err(CommitError::Collision)));
    assert_eq!(collision_draws.load(Ordering::SeqCst), 1);

    let second = RootAuthority::synthetic(
        reopen_test_store(directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock("2026-09-03T12:15:00Z"),
        FixedEntropy([4; 32]),
    )
    .expect("second authority");
    let terminal = second.inspect().expect("terminal inventory").1;
    let mut second_candidate = candidate("2026-09-03T12:30:00Z");
    second_candidate.operation_id = digest('6');
    second_candidate.authorization_nonce = digest('7');
    second_candidate.envelope_sha256 = digest('8');
    second_candidate.external_exclusive_window_expires_at = "2026-09-03T12:30:00.000Z".to_owned();
    let second_registered = second
        .register(RegisterCommand::new(
            HeadCas::new(terminal.generation, terminal.transition_sha256),
            second_candidate,
        ))
        .expect("second registration");
    drop(second_registered);
    drop(second);

    let recovered = RootAuthority::synthetic(
        reopen_test_store(directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock("2026-09-03T12:30:00Z"),
        FixedEntropy([5; 32]),
    )
    .expect("recovered authority");
    let historical = recovered
        .status(StatusCommand::new(first_candidate.operation_id))
        .expect("historical status");
    assert_eq!(historical.test_availability(), Some("recovery_only"));
    drop(historical);
    let current = recovered
        .status(StatusCommand::new(digest('6')))
        .expect("current status");
    assert_eq!(current.test_availability(), Some("recovery_only"));
}

#[test]
fn restart_states_recover_conservatively_and_only_attended_expiry_can_close() {
    use std::fs::Permissions;
    use std::os::unix::fs::PermissionsExt;

    let signer = SyntheticRecordSigner::from_seed([7; 32]);

    let (empty_directory, empty_store) = empty_test_store(signer.public_key_bytes());
    drop(empty_store);
    assert_eq!(
        reopen_test_store(empty_directory.path(), signer.public_key_bytes())
            .inspect()
            .expect("clean reopen")
            .0,
        Health::Available
    );

    let (candidate_directory, candidate_store) = empty_test_store(signer.public_key_bytes());
    let candidate_live = RootAuthority::synthetic(
        candidate_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock(NOW),
        FixedEntropy([3; 32]),
    )
    .expect("candidate live authority");
    let (registered, value) = commit_test_registration(&candidate_live);
    drop(candidate_live);
    let candidate_recovered = RootAuthority::synthetic(
        reopen_test_store(candidate_directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock("2026-09-03T12:15:00Z"),
        FixedEntropy([4; 32]),
    )
    .expect("candidate recovered authority");
    let (command, candidate_authentication) =
        candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:14:30Z");
    let closure = candidate_recovered
        .close_candidate(command, &candidate_authentication)
        .expect("recovered candidate closure");
    assert_eq!(closure.test_snapshot().0, "candidate_expired");
    drop(closure);
    assert!(matches!(
        candidate_recovered
            .inspect()
            .expect("candidate terminal")
            .1
            .state,
        VerifiedState::CandidateExpired { .. }
    ));
    drop(candidate_recovered);
    assert_eq!(
        reopen_test_store(candidate_directory.path(), signer.public_key_bytes())
            .inspect()
            .expect("terminal reopen")
            .0,
        Health::Available
    );

    let (approval_directory, approval_store) = empty_test_store(signer.public_key_bytes());
    let approval_live = RootAuthority::synthetic(
        approval_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("approval live authority");
    let (registered, value) = commit_test_registration(&approval_live);
    let approved = commit_test_approval(&approval_live, &registered, &value);
    drop(approval_live);
    let approval_recovered = RootAuthority::synthetic(
        reopen_test_store(approval_directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock("2026-09-03T12:15:00Z"),
        FixedEntropy([4; 32]),
    )
    .expect("approval recovered authority");
    let (command, approval_authentication) =
        approval_close_inputs(&approved, &value, '0', "2026-09-03T12:14:30Z");
    let closure = approval_recovered
        .close_approval(command, &approval_authentication)
        .expect("recovered approval closure");
    assert_eq!(closure.test_snapshot().0, "approval_expired");
    drop(closure);
    assert!(matches!(
        approval_recovered
            .inspect()
            .expect("approval terminal")
            .1
            .state,
        VerifiedState::ApprovalExpired { .. }
    ));

    let (consumed_directory, consumed_store) = empty_test_store(signer.public_key_bytes());
    let consumed_live = RootAuthority::synthetic(
        consumed_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        SequenceClock::new([NOW, NOW, NOW]),
        FixedEntropy([3; 32]),
    )
    .expect("consumed live authority");
    let (registered, value) = commit_test_registration(&consumed_live);
    let approved = commit_test_approval(&consumed_live, &registered, &value);
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    drop(
        consumed_live
            .consume(ConsumeCommand::new(
                HeadCas::new(approved.generation, approved.transition_sha256),
                value.operation_id.clone(),
                value.authorization_nonce,
                grant_sha256,
                grant_signature_sha256,
            ))
            .expect("consume"),
    );
    drop(consumed_live);
    let consumed_recovered = RootAuthority::synthetic(
        reopen_test_store(consumed_directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock(NOW),
        FixedEntropy([4; 32]),
    )
    .expect("consumed recovered authority");
    assert_eq!(
        consumed_recovered.inspect().expect("consumed").0,
        Health::RecoveredNonterminal
    );

    let (corrupt_directory, corrupt_store) = empty_test_store(signer.public_key_bytes());
    let corrupt_live = RootAuthority::synthetic(
        corrupt_store,
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock(NOW),
        FixedEntropy([3; 32]),
    )
    .expect("corrupt live authority");
    let (registered, value) = commit_test_registration(&corrupt_live);
    drop(corrupt_live);
    let corrupt_recovered = RootAuthority::synthetic(
        reopen_test_store(corrupt_directory.path(), signer.public_key_bytes()),
        SyntheticRecordSigner::from_seed([7; 32]),
        FixedClock(NOW),
        FixedEntropy([4; 32]),
    )
    .expect("corrupt recovered authority");
    let candidate_sha256 = match &registered.state {
        VerifiedState::CandidateRegistered {
            candidate_sha256, ..
        } => candidate_sha256,
        _ => panic!("candidate state"),
    };
    std::fs::set_permissions(
        corrupt_directory
            .path()
            .join("objects/leaves")
            .join(candidate_sha256),
        Permissions::from_mode(0o640),
    )
    .expect("corrupt retained mode");
    let verified =
        RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified envelope");
    let attended = authentication(&value);
    let outcome = corrupt_recovered.approve(
        ApproveCommand::new(
            HeadCas::new(registered.generation, registered.transition_sha256),
            value.operation_id,
            value.authorization_nonce,
            value.envelope_sha256,
            value.approval_challenge_sha256,
        ),
        &verified,
        &attended,
    );
    assert_eq!(outcome.test_error(), Some(CommitError::Unavailable));
    drop(outcome);
    assert_eq!(corrupt_recovered.inspect(), Err(StorageError::Sealed));
}

#[test]
fn every_register_publication_fault_reopens_as_predecessor_successor_or_sealed() {
    for point in publication_fault_points(3) {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let (directory, store) = empty_test_store(public_key);
        let authority =
            RootAuthority::synthetic(store, signer, FixedClock(NOW), FixedEntropy([3; 32]))
                .expect("authority open");
        test_fail_at(point);
        let outcome = authority.register(RegisterCommand::new(
            HeadCas::new(0, GENESIS_SHA256.to_owned()),
            candidate("2026-09-03T12:15:00Z"),
        ));
        assert_eq!(
            outcome.test_error(),
            Some(CommitError::Unavailable),
            "{point:?}"
        );
        drop(outcome);
        test_clear_fault();
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(authority.inspect().is_ok(), "{point:?}");
        } else {
            assert_eq!(authority.inspect(), Err(StorageError::Sealed), "{point:?}");
        }
        drop(authority);

        let reopened = reopen_test_store(directory.path(), public_key);
        if point == TestFaultPoint::BeforeFirstPublication {
            let (health, snapshot) = reopened.inspect().expect("exact predecessor");
            assert_eq!(health, Health::Available);
            assert!(matches!(snapshot.state, VerifiedState::Empty));
        } else if fault_has_complete_transition(point, 3) {
            let (health, snapshot) = reopened.inspect().expect("conservative successor");
            assert_eq!(health, Health::RecoveredNonterminal);
            assert!(matches!(
                snapshot.state,
                VerifiedState::CandidateRegistered { .. }
            ));
        } else {
            assert_eq!(reopened.inspect(), Err(StorageError::Sealed), "{point:?}");
        }
    }
}

#[test]
fn every_approve_consume_and_closure_publication_fault_is_conservative() {
    for point in publication_fault_points(4) {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let (directory, store) = empty_test_store(public_key);
        let authority = RootAuthority::synthetic(
            store,
            signer,
            SequenceClock::new([NOW, NOW]),
            FixedEntropy([3; 32]),
        )
        .expect("approve authority");
        let (registered, value) = commit_test_registration(&authority);
        let verified = RootVerifiedPreparedEnvelope::synthetic(&value, observations())
            .expect("verified envelope");
        let attended = authentication(&value);
        test_fail_at(point);
        let outcome = authority.approve(
            ApproveCommand::new(
                HeadCas::new(registered.generation, registered.transition_sha256),
                value.operation_id,
                value.authorization_nonce,
                value.envelope_sha256,
                value.approval_challenge_sha256,
            ),
            &verified,
            &attended,
        );
        assert_eq!(
            outcome.test_error(),
            Some(CommitError::Unavailable),
            "approve {point:?}"
        );
        drop(outcome);
        test_clear_fault();
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(matches!(
                authority.inspect().expect("approve predecessor").1.state,
                VerifiedState::CandidateRegistered { .. }
            ));
        } else {
            assert_eq!(
                authority.inspect(),
                Err(StorageError::Sealed),
                "approve {point:?}"
            );
        }
        drop(authority);
        let reopened = reopen_test_store(directory.path(), public_key);
        if point == TestFaultPoint::BeforeFirstPublication {
            let (health, snapshot) = reopened.inspect().expect("approve predecessor reopen");
            assert_eq!(health, Health::RecoveredNonterminal);
            assert!(matches!(
                snapshot.state,
                VerifiedState::CandidateRegistered { .. }
            ));
        } else if fault_has_complete_transition(point, 4) {
            let (health, snapshot) = reopened.inspect().expect("approve successor reopen");
            assert_eq!(health, Health::RecoveredNonterminal);
            assert!(matches!(snapshot.state, VerifiedState::Approved { .. }));
        } else {
            assert_eq!(
                reopened.inspect(),
                Err(StorageError::Sealed),
                "approve {point:?}"
            );
        }
    }

    for point in publication_fault_points(4) {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let (directory, store) = empty_test_store(public_key);
        let authority = RootAuthority::synthetic(
            store,
            signer,
            SequenceClock::new([NOW, NOW, NOW]),
            FixedEntropy([3; 32]),
        )
        .expect("consume authority");
        let (registered, value) = commit_test_registration(&authority);
        let approved = commit_test_approval(&authority, &registered, &value);
        let (grant_sha256, grant_signature_sha256) = match &approved.state {
            VerifiedState::Approved {
                grant_sha256,
                grant_signature_sha256,
                ..
            } => (grant_sha256.clone(), grant_signature_sha256.clone()),
            _ => panic!("approved state"),
        };
        test_fail_at(point);
        let outcome = authority.consume(ConsumeCommand::new(
            HeadCas::new(approved.generation, approved.transition_sha256),
            value.operation_id,
            value.authorization_nonce,
            grant_sha256,
            grant_signature_sha256,
        ));
        assert_eq!(
            outcome.test_error(),
            Some(CommitError::Unavailable),
            "consume {point:?}"
        );
        drop(outcome);
        test_clear_fault();
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(matches!(
                authority.inspect().expect("consume predecessor").1.state,
                VerifiedState::Approved { .. }
            ));
        } else {
            assert_eq!(
                authority.inspect(),
                Err(StorageError::Sealed),
                "consume {point:?}"
            );
        }
        drop(authority);
        let reopened = reopen_test_store(directory.path(), public_key);
        if point == TestFaultPoint::BeforeFirstPublication {
            let (health, snapshot) = reopened.inspect().expect("consume predecessor reopen");
            assert_eq!(health, Health::RecoveredNonterminal);
            assert!(matches!(snapshot.state, VerifiedState::Approved { .. }));
        } else if fault_has_complete_transition(point, 4) {
            let (health, snapshot) = reopened.inspect().expect("consume successor reopen");
            assert_eq!(health, Health::RecoveredNonterminal);
            assert!(matches!(snapshot.state, VerifiedState::Consumed { .. }));
        } else {
            assert_eq!(
                reopened.inspect(),
                Err(StorageError::Sealed),
                "consume {point:?}"
            );
        }
    }

    for point in publication_fault_points(2) {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let (directory, store) = empty_test_store(public_key);
        let authority = RootAuthority::synthetic(
            store,
            signer,
            SequenceClock::new([NOW, "2026-09-03T12:15:00Z"]),
            FixedEntropy([3; 32]),
        )
        .expect("candidate closure authority");
        let (registered, value) = commit_test_registration(&authority);
        let (command, attended) =
            candidate_close_inputs(&registered, &value, '0', "2026-09-03T12:14:30Z");
        test_fail_at(point);
        let outcome = authority.close_candidate(command, &attended);
        assert_eq!(
            outcome.test_error(),
            Some(CommitError::Unavailable),
            "candidate closure {point:?}"
        );
        drop(outcome);
        test_clear_fault();
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(matches!(
                authority.inspect().expect("candidate predecessor").1.state,
                VerifiedState::CandidateRegistered { .. }
            ));
        } else {
            assert_eq!(
                authority.inspect(),
                Err(StorageError::Sealed),
                "candidate closure {point:?}"
            );
        }
        drop(authority);
        let reopened = reopen_test_store(directory.path(), public_key);
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(matches!(
                reopened
                    .inspect()
                    .expect("candidate predecessor reopen")
                    .1
                    .state,
                VerifiedState::CandidateRegistered { .. }
            ));
        } else if fault_has_complete_transition(point, 2) {
            let (health, snapshot) = reopened.inspect().expect("candidate closure successor");
            assert_eq!(health, Health::Available);
            assert!(matches!(
                snapshot.state,
                VerifiedState::CandidateExpired { .. }
            ));
        } else {
            assert_eq!(
                reopened.inspect(),
                Err(StorageError::Sealed),
                "candidate closure {point:?}"
            );
        }
    }

    for point in publication_fault_points(2) {
        let signer = SyntheticRecordSigner::from_seed([7; 32]);
        let public_key = signer.public_key_bytes();
        let (directory, store) = empty_test_store(public_key);
        let authority = RootAuthority::synthetic(
            store,
            signer,
            SequenceClock::new([NOW, NOW, "2026-09-03T12:09:30Z"]),
            FixedEntropy([3; 32]),
        )
        .expect("approval closure authority");
        let (registered, value) = commit_test_registration(&authority);
        let approved = commit_test_approval(&authority, &registered, &value);
        let (command, attended) =
            approval_close_inputs(&approved, &value, '0', "2026-09-03T12:09:00Z");
        test_fail_at(point);
        let outcome = authority.close_approval(command, &attended);
        assert_eq!(
            outcome.test_error(),
            Some(CommitError::Unavailable),
            "approval closure {point:?}"
        );
        drop(outcome);
        test_clear_fault();
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(matches!(
                authority.inspect().expect("approval predecessor").1.state,
                VerifiedState::Approved { .. }
            ));
        } else {
            assert_eq!(
                authority.inspect(),
                Err(StorageError::Sealed),
                "approval closure {point:?}"
            );
        }
        drop(authority);
        let reopened = reopen_test_store(directory.path(), public_key);
        if point == TestFaultPoint::BeforeFirstPublication {
            assert!(matches!(
                reopened
                    .inspect()
                    .expect("approval predecessor reopen")
                    .1
                    .state,
                VerifiedState::Approved { .. }
            ));
        } else if fault_has_complete_transition(point, 2) {
            let (health, snapshot) = reopened.inspect().expect("approval closure successor");
            assert_eq!(health, Health::Available);
            assert!(matches!(
                snapshot.state,
                VerifiedState::ApprovalExpired { .. }
            ));
        } else {
            assert_eq!(
                reopened.inspect(),
                Err(StorageError::Sealed),
                "approval closure {point:?}"
            );
        }
    }
}

#[test]
fn same_cas_thread_races_have_one_signing_clock_entropy_and_successor_winner() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CONTENDERS: usize = 8;
    let signature_calls = Arc::new(AtomicUsize::new(0));
    let clock_calls = Arc::new(AtomicUsize::new(0));
    let entropy_calls = Arc::new(AtomicUsize::new(0));
    let signer = CountingSigner {
        inner: SyntheticRecordSigner::from_seed([7; 32]),
        calls: Arc::clone(&signature_calls),
    };
    let (_directory, store) = empty_test_store(signer.public_key_bytes());
    let authority = RootAuthority::synthetic(
        store,
        signer,
        CountingClock {
            calls: Arc::clone(&clock_calls),
        },
        CountingEntropy {
            calls: Arc::clone(&entropy_calls),
        },
    )
    .expect("authority open");

    let register_winners = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..CONTENDERS)
            .map(|_| {
                scope.spawn(|| {
                    authority
                        .register(RegisterCommand::new(
                            HeadCas::new(0, GENESIS_SHA256.to_owned()),
                            candidate("2026-09-03T12:15:00Z"),
                        ))
                        .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("register contender")))
            .sum::<usize>()
    });
    assert_eq!(register_winners, 1);
    assert_eq!(signature_calls.load(Ordering::SeqCst), 1);
    assert_eq!(clock_calls.load(Ordering::SeqCst), 1);

    let (_, registered) = authority.inspect().expect("registered");
    let registered_candidate = match &registered.state {
        VerifiedState::CandidateRegistered { candidate, .. } => candidate.as_ref().clone(),
        _ => panic!("registered state"),
    };
    let approve_generation = registered.generation;
    let approve_transition = registered.transition_sha256;
    let approve_winners = std::thread::scope(|scope| {
        let authority = &authority;
        let handles: Vec<_> = (0..CONTENDERS)
            .map(|_| {
                let candidate = registered_candidate.clone();
                let transition = approve_transition.clone();
                scope.spawn(move || {
                    let verified =
                        RootVerifiedPreparedEnvelope::synthetic(&candidate, observations())
                            .expect("verified");
                    let auth = authentication(&candidate);
                    authority
                        .approve(
                            ApproveCommand::new(
                                HeadCas::new(approve_generation, transition),
                                candidate.operation_id.clone(),
                                candidate.authorization_nonce.clone(),
                                candidate.envelope_sha256.clone(),
                                candidate.approval_challenge_sha256.clone(),
                            ),
                            &verified,
                            &auth,
                        )
                        .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("approve contender")))
            .sum::<usize>()
    });
    assert_eq!(approve_winners, 1);
    assert_eq!(signature_calls.load(Ordering::SeqCst), 3);
    assert_eq!(clock_calls.load(Ordering::SeqCst), 2);

    let (_, approved) = authority.inspect().expect("approved");
    let (grant_sha256, grant_signature_sha256) = match &approved.state {
        VerifiedState::Approved {
            grant_sha256,
            grant_signature_sha256,
            ..
        } => (grant_sha256.clone(), grant_signature_sha256.clone()),
        _ => panic!("approved state"),
    };
    let consume_generation = approved.generation;
    let consume_transition = approved.transition_sha256;
    let consume_winners = std::thread::scope(|scope| {
        let authority = &authority;
        let handles: Vec<_> = (0..CONTENDERS)
            .map(|_| {
                let transition = consume_transition.clone();
                let grant_sha256 = grant_sha256.clone();
                let grant_signature_sha256 = grant_signature_sha256.clone();
                let candidate = registered_candidate.clone();
                scope.spawn(move || {
                    authority
                        .consume(ConsumeCommand::new(
                            HeadCas::new(consume_generation, transition),
                            candidate.operation_id,
                            candidate.authorization_nonce,
                            grant_sha256,
                            grant_signature_sha256,
                        ))
                        .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| usize::from(handle.join().expect("consume contender")))
            .sum::<usize>()
    });
    assert_eq!(consume_winners, 1);
    assert_eq!(signature_calls.load(Ordering::SeqCst), 5);
    assert_eq!(clock_calls.load(Ordering::SeqCst), 3);
    assert_eq!(entropy_calls.load(Ordering::SeqCst), 2);
    let (_, consumed) = authority.inspect().expect("consumed");
    assert!(matches!(consumed.state, VerifiedState::Consumed { .. }));
}

#[test]
fn authenticated_supervisor_request_commits_and_emits_one_proof_bearing_response() {
    use rustix::net::sockopt::socket_peercred;
    use rustix::net::{
        AddressFamily, RecvFlags, SendFlags, Shutdown, SocketFlags, SocketType, recv, send,
        shutdown, socketpair,
    };

    use crate::ipc::{PeerPolicy, SupervisorIngress, prepare_supervisor};

    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let (_directory, store) = empty_test_store(signer.public_key_bytes());
    let authority = RootAuthority::synthetic(store, signer, FixedClock(NOW), FixedEntropy([3; 32]))
        .expect("authority open");
    let value = candidate("2026-09-03T12:15:00Z");
    let frame = register_request_frame(0, GENESIS_SHA256, &value);
    let (client, server) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .expect("socket pair");
    let policy = PeerPolicy::synthetic(socket_peercred(&server).expect("peer credentials"));
    let prepared = prepare_supervisor(server, &policy).expect("prepared supervisor");
    assert_eq!(
        send(&client, &frame, SendFlags::NOSIGNAL).expect("request send"),
        frame.len()
    );
    shutdown(&client, Shutdown::Write).expect("write shutdown");
    let ingress = prepared.receive().expect("authenticated request");
    match ingress {
        SupervisorIngress::Request {
            request: SupervisorRequest::Register(request),
            reply,
        } => authority
            .register(request.into_command())
            .expect("commit")
            .attempt(reply)
            .expect("response"),
        _ => panic!("registered supervisor request"),
    }
    let mut response_bytes = vec![0_u8; crate::protocol::MAX_FRAME_BYTES];
    let (response_len, _) = recv(&client, &mut response_bytes, RecvFlags::empty())
        .expect("one complete response packet");
    response_bytes.truncate(response_len);
    assert_frame_type(&response_bytes, SUPERVISOR_REGISTER_SUCCESS);
    let response = frame_text(&response_bytes);
    assert!(response.contains("\"status\": \"committed\""));
    for private_canary in [
        &value.operation_id,
        &value.authorization_nonce,
        &value.target_fingerprint,
        &value.target_selection_sha256,
        &value.envelope_sha256,
        &value.external_exclusive_window_evidence_sha256,
        &value.official_source_evidence_sha256,
        &value.native_runtime_identity_sha256,
        &value.child_sandbox_policy_sha256,
        &value.phase_exec_topology_policy_sha256,
        &value.child_cgroup_policy_sha256,
        &value.apply_invocation_evidence_sha256,
    ] {
        assert!(!response.contains(private_canary));
    }
}

#[test]
fn lost_closed_and_partial_approval_replies_never_resign_the_grant() {
    use std::os::fd::OwnedFd;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use rustix::net::sockopt::socket_peercred;
    use rustix::net::{
        AddressFamily, RecvFlags, SendFlags, Shutdown, SocketFlags, SocketType, recv, send,
        shutdown, socketpair,
    };

    use crate::ipc::{IpcError, OperatorIngress, PeerPolicy, prepare_operator};
    use crate::journal::storage::ResponseAttemptError;

    #[derive(Clone, Copy, Debug)]
    enum ReplyLoss {
        Dropped,
        ClosedPeer,
        Partial,
    }

    fn ingress(frame: &[u8]) -> (OwnedFd, OperatorIngress) {
        let (client, server) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .expect("socket pair");
        let policy = PeerPolicy::synthetic(socket_peercred(&server).expect("peer credentials"));
        let prepared = prepare_operator(server, &policy).expect("prepared operator");
        assert_eq!(
            send(&client, frame, SendFlags::NOSIGNAL).expect("request send"),
            frame.len()
        );
        shutdown(&client, Shutdown::Write).expect("write shutdown");
        (
            client,
            prepared.receive().expect("authenticated operator request"),
        )
    }

    fn receive_record(client: &OwnedFd) -> Vec<u8> {
        let mut bytes = vec![0_u8; crate::protocol::MAX_FRAME_BYTES];
        let (received, reported) =
            recv(client, &mut bytes, RecvFlags::empty()).expect("response receive");
        assert_eq!(received, reported);
        bytes.truncate(received);
        bytes
    }

    fn assert_eof(client: &OwnedFd) {
        assert!(receive_record(client).is_empty());
    }

    fn run(mode: ReplyLoss) {
        let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();
        let signer_calls = Arc::new(AtomicUsize::new(0));
        let clock_calls = Arc::new(AtomicUsize::new(0));
        let entropy_calls = Arc::new(AtomicUsize::new(0));
        let (directory, store) = empty_test_store(public_key);
        let authority = RootAuthority::synthetic(
            store,
            CountingSigner {
                inner: SyntheticRecordSigner::from_seed([7; 32]),
                calls: Arc::clone(&signer_calls),
            },
            CountingClock {
                calls: Arc::clone(&clock_calls),
            },
            CountingEntropyValue {
                calls: Arc::clone(&entropy_calls),
                value: [3; 32],
            },
        )
        .expect("authority");
        let (registered, value) = commit_test_registration(&authority);
        let verified =
            RootVerifiedPreparedEnvelope::synthetic(&value, observations()).expect("verified");
        let attended = authentication(&value);
        let (client, request) = ingress(&approve_request_frame(&registered, &value));
        let (request, reply) = match request {
            OperatorIngress::Request {
                request: crate::protocol::OperatorRequest::Approve(request),
                reply,
            } => (request, reply),
            _ => panic!("approve request"),
        };
        let committed = authority
            .approve(request.into_command(), &verified, &attended)
            .expect("durably approved");
        match mode {
            ReplyLoss::Dropped => {
                drop(committed);
                drop(reply);
                assert_eof(&client);
            }
            ReplyLoss::ClosedPeer => {
                drop(client);
                assert_eq!(
                    committed.attempt(reply),
                    Err(ResponseAttemptError::Send(IpcError::Send))
                );
            }
            ReplyLoss::Partial => {
                let prefix_len = crate::protocol::FRAME_HEADER_BYTES + 8;
                assert_eq!(
                    committed.attempt_prefix_for_test(reply, prefix_len),
                    Err(ResponseAttemptError::Send(IpcError::PartialSend))
                );
                assert_eq!(receive_record(&client).len(), prefix_len);
                assert_eof(&client);
            }
        }

        assert_eq!(signer_calls.load(Ordering::SeqCst), 3, "{mode:?}");
        assert_eq!(clock_calls.load(Ordering::SeqCst), 2, "{mode:?}");
        assert_eq!(entropy_calls.load(Ordering::SeqCst), 1, "{mode:?}");
        let (_, approved) = authority.inspect().expect("approved inventory");
        assert!(matches!(approved.state, VerifiedState::Approved { .. }));
        let entries_after_approval = journal_entry_count(directory.path());

        let replay = authority.approve(
            ApproveCommand::new(
                HeadCas::new(approved.generation, approved.transition_sha256.clone()),
                value.operation_id.clone(),
                value.authorization_nonce.clone(),
                value.envelope_sha256.clone(),
                value.approval_challenge_sha256.clone(),
            ),
            &verified,
            &attended,
        );
        assert_eq!(replay.test_error(), Some(CommitError::InvalidState));
        drop(replay);
        assert_eq!(signer_calls.load(Ordering::SeqCst), 3, "{mode:?}");
        assert_eq!(clock_calls.load(Ordering::SeqCst), 2, "{mode:?}");
        assert_eq!(entropy_calls.load(Ordering::SeqCst), 1, "{mode:?}");
        assert_eq!(
            journal_entry_count(directory.path()),
            entries_after_approval
        );

        let status = authority
            .status(StatusCommand::new(value.operation_id.clone()))
            .expect("approved status");
        assert_eq!(status.test_snapshot().0, "approved");
        drop(status);
        drop(authority);

        let restart_signer_calls = Arc::new(AtomicUsize::new(0));
        let restart_clock_calls = Arc::new(AtomicUsize::new(0));
        let restart_entropy_calls = Arc::new(AtomicUsize::new(0));
        let recovered = RootAuthority::synthetic(
            reopen_test_store(directory.path(), public_key),
            CountingSigner {
                inner: SyntheticRecordSigner::from_seed([7; 32]),
                calls: Arc::clone(&restart_signer_calls),
            },
            CountingClock {
                calls: Arc::clone(&restart_clock_calls),
            },
            CountingEntropyValue {
                calls: Arc::clone(&restart_entropy_calls),
                value: [4; 32],
            },
        )
        .expect("recovered authority");
        assert_eq!(restart_entropy_calls.load(Ordering::SeqCst), 1);
        let replay = recovered.approve(
            ApproveCommand::new(
                HeadCas::new(approved.generation, approved.transition_sha256),
                value.operation_id.clone(),
                value.authorization_nonce,
                value.envelope_sha256,
                value.approval_challenge_sha256,
            ),
            &verified,
            &attended,
        );
        assert_eq!(replay.test_error(), Some(CommitError::RecoveryOnly));
        drop(replay);
        assert_eq!(restart_signer_calls.load(Ordering::SeqCst), 0, "{mode:?}");
        assert_eq!(restart_clock_calls.load(Ordering::SeqCst), 0, "{mode:?}");
        assert_eq!(restart_entropy_calls.load(Ordering::SeqCst), 1, "{mode:?}");
        assert_eq!(
            journal_entry_count(directory.path()),
            entries_after_approval
        );
        assert_eq!(
            recovered
                .status(StatusCommand::new(value.operation_id))
                .expect("recovered status")
                .test_availability(),
            Some("recovery_only")
        );
    }

    for mode in [
        ReplyLoss::Dropped,
        ReplyLoss::ClosedPeer,
        ReplyLoss::Partial,
    ] {
        run(mode);
    }
}

#[test]
fn lost_closed_and_partial_consume_replies_never_remint_the_bearer() {
    use std::os::fd::OwnedFd;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use rustix::net::sockopt::socket_peercred;
    use rustix::net::{
        AddressFamily, RecvFlags, SendFlags, Shutdown, SocketFlags, SocketType, recv, send,
        shutdown, socketpair,
    };

    use crate::ipc::{IpcError, PeerPolicy, SupervisorIngress, prepare_supervisor};
    use crate::journal::storage::ResponseAttemptError;

    #[derive(Clone, Copy, Debug)]
    enum ReplyLoss {
        Dropped,
        ClosedPeer,
        Partial,
    }

    fn ingress(frame: &[u8]) -> (OwnedFd, SupervisorIngress) {
        let (client, server) = socketpair(
            AddressFamily::UNIX,
            SocketType::SEQPACKET,
            SocketFlags::CLOEXEC,
            None,
        )
        .expect("socket pair");
        let policy = PeerPolicy::synthetic(socket_peercred(&server).expect("peer credentials"));
        let prepared = prepare_supervisor(server, &policy).expect("prepared supervisor");
        assert_eq!(
            send(&client, frame, SendFlags::NOSIGNAL).expect("request send"),
            frame.len()
        );
        shutdown(&client, Shutdown::Write).expect("write shutdown");
        (
            client,
            prepared
                .receive()
                .expect("authenticated supervisor request"),
        )
    }

    fn receive_record(client: &OwnedFd) -> Vec<u8> {
        let mut bytes = vec![0_u8; crate::protocol::MAX_FRAME_BYTES];
        let (received, reported) =
            recv(client, &mut bytes, RecvFlags::empty()).expect("response receive");
        assert_eq!(received, reported);
        bytes.truncate(received);
        bytes
    }

    fn assert_eof(client: &OwnedFd) {
        assert!(receive_record(client).is_empty());
    }

    fn run(mode: ReplyLoss) {
        let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();
        let signer_calls = Arc::new(AtomicUsize::new(0));
        let clock_calls = Arc::new(AtomicUsize::new(0));
        let entropy_calls = Arc::new(AtomicUsize::new(0));
        let (directory, store) = empty_test_store(public_key);
        let authority = RootAuthority::synthetic(
            store,
            CountingSigner {
                inner: SyntheticRecordSigner::from_seed([7; 32]),
                calls: Arc::clone(&signer_calls),
            },
            CountingClock {
                calls: Arc::clone(&clock_calls),
            },
            CountingEntropyValue {
                calls: Arc::clone(&entropy_calls),
                value: [3; 32],
            },
        )
        .expect("authority");
        let (registered, value) = commit_test_registration(&authority);
        let approved = commit_test_approval(&authority, &registered, &value);
        let (grant_sha256, grant_signature_sha256) = match &approved.state {
            VerifiedState::Approved {
                grant_sha256,
                grant_signature_sha256,
                ..
            } => (grant_sha256.clone(), grant_signature_sha256.clone()),
            _ => panic!("approved state"),
        };

        let (client, request) = ingress(&consume_request_frame(&approved, &value));
        let (request, reply) = match request {
            SupervisorIngress::Request {
                request: SupervisorRequest::Consume(request),
                reply,
            } => (request, reply),
            _ => panic!("consume request"),
        };
        let committed = authority
            .consume(request.into_command())
            .expect("durably consumed");
        match mode {
            ReplyLoss::Dropped => {
                drop(committed);
                drop(reply);
                assert_eof(&client);
            }
            ReplyLoss::ClosedPeer => {
                drop(client);
                assert_eq!(
                    committed.attempt(reply),
                    Err(ResponseAttemptError::Send(IpcError::Send))
                );
            }
            ReplyLoss::Partial => {
                let prefix_len = crate::protocol::FRAME_HEADER_BYTES + 8;
                assert_eq!(
                    committed.attempt_prefix_for_test(reply, prefix_len),
                    Err(ResponseAttemptError::Send(IpcError::PartialSend))
                );
                assert_eq!(receive_record(&client).len(), prefix_len);
                assert_eof(&client);
            }
        }

        assert_eq!(signer_calls.load(Ordering::SeqCst), 5, "{mode:?}");
        assert_eq!(clock_calls.load(Ordering::SeqCst), 3, "{mode:?}");
        assert_eq!(entropy_calls.load(Ordering::SeqCst), 2, "{mode:?}");
        let (_, consumed) = authority.inspect().expect("consumed inventory");
        assert!(matches!(consumed.state, VerifiedState::Consumed { .. }));
        let entries_after_consume = journal_entry_count(directory.path());

        let replay = authority.consume(ConsumeCommand::new(
            HeadCas::new(consumed.generation, consumed.transition_sha256.clone()),
            value.operation_id.clone(),
            value.authorization_nonce.clone(),
            grant_sha256.clone(),
            grant_signature_sha256.clone(),
        ));
        assert_eq!(replay.test_error(), Some(CommitError::InvalidState));
        drop(replay);
        assert_eq!(signer_calls.load(Ordering::SeqCst), 5, "{mode:?}");
        assert_eq!(clock_calls.load(Ordering::SeqCst), 3, "{mode:?}");
        assert_eq!(entropy_calls.load(Ordering::SeqCst), 2, "{mode:?}");
        assert_eq!(journal_entry_count(directory.path()), entries_after_consume);

        let (status_client, status_ingress) = ingress(&status_request_frame(&value.operation_id));
        match status_ingress {
            SupervisorIngress::Request {
                request: SupervisorRequest::Status(request),
                reply,
            } => authority
                .status(request.into_command())
                .expect("status")
                .attempt(reply)
                .expect("status response"),
            _ => panic!("status request"),
        }
        let status = receive_record(&status_client);
        assert_frame_type(&status, SUPERVISOR_STATUS_SUCCESS);
        let status = frame_text(&status);
        assert!(status.contains("executionTicketSha256"));
        assert!(status.contains("executionTicketSignatureSha256"));
        assert!(!status.contains("executionTicketCanonicalHex"));
        assert!(!status.contains("executionTicketRawSignatureHex"));
        assert!(!status.contains(&value.operation_id));
        assert!(!status.contains(&value.authorization_nonce));
        assert!(!status.contains(&value.target_fingerprint));
        assert_eof(&status_client);

        drop(authority);
        let restart_signer_calls = Arc::new(AtomicUsize::new(0));
        let restart_clock_calls = Arc::new(AtomicUsize::new(0));
        let restart_entropy_calls = Arc::new(AtomicUsize::new(0));
        let recovered = RootAuthority::synthetic(
            reopen_test_store(directory.path(), public_key),
            CountingSigner {
                inner: SyntheticRecordSigner::from_seed([7; 32]),
                calls: Arc::clone(&restart_signer_calls),
            },
            CountingClock {
                calls: Arc::clone(&restart_clock_calls),
            },
            CountingEntropyValue {
                calls: Arc::clone(&restart_entropy_calls),
                value: [4; 32],
            },
        )
        .expect("recovered authority");
        assert_eq!(restart_entropy_calls.load(Ordering::SeqCst), 1);
        let replay = recovered.consume(ConsumeCommand::new(
            HeadCas::new(consumed.generation, consumed.transition_sha256),
            value.operation_id.clone(),
            value.authorization_nonce,
            grant_sha256,
            grant_signature_sha256,
        ));
        assert_eq!(replay.test_error(), Some(CommitError::RecoveryOnly));
        drop(replay);
        assert_eq!(restart_signer_calls.load(Ordering::SeqCst), 0, "{mode:?}");
        assert_eq!(restart_clock_calls.load(Ordering::SeqCst), 0, "{mode:?}");
        assert_eq!(restart_entropy_calls.load(Ordering::SeqCst), 1, "{mode:?}");
        assert_eq!(journal_entry_count(directory.path()), entries_after_consume);
        assert_eq!(
            recovered
                .status(StatusCommand::new(value.operation_id))
                .expect("recovered status")
                .test_availability(),
            Some("recovery_only")
        );
    }

    for mode in [
        ReplyLoss::Dropped,
        ReplyLoss::ClosedPeer,
        ReplyLoss::Partial,
    ] {
        run(mode);
    }
}

#[test]
fn losing_refusal_holds_the_mutation_mutex_through_its_single_send_attempt() {
    use std::sync::mpsc::{RecvTimeoutError, channel};
    use std::time::Duration;

    use rustix::net::sockopt::socket_peercred;
    use rustix::net::{
        AddressFamily, RecvFlags, SendFlags, Shutdown, SocketFlags, SocketType, recv, send,
        shutdown, socketpair,
    };

    use crate::ipc::{PeerPolicy, SupervisorIngress, prepare_supervisor};

    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let (_directory, store) = empty_test_store(signer.public_key_bytes());
    let authority = RootAuthority::synthetic(store, signer, FixedClock(NOW), FixedEntropy([3; 32]))
        .expect("authority open");
    let value = candidate("2026-09-03T12:15:00Z");
    let refusal = authority.register(RegisterCommand::new(
        HeadCas::new(1, digest('0')),
        value.clone(),
    ));
    assert_eq!(refusal.test_error(), Some(CommitError::Stale));

    let frame = register_request_frame(1, &digest('0'), &value);
    let (client, server) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC,
        None,
    )
    .expect("socket pair");
    let policy = PeerPolicy::synthetic(socket_peercred(&server).expect("peer credentials"));
    let prepared = prepare_supervisor(server, &policy).expect("prepared supervisor");
    assert_eq!(
        send(&client, &frame, SendFlags::NOSIGNAL).expect("request send"),
        frame.len()
    );
    shutdown(&client, Shutdown::Write).expect("write shutdown");
    let reply = match prepared.receive().expect("authenticated request") {
        SupervisorIngress::Request { reply, .. } => reply,
        _ => panic!("classified supervisor request"),
    };

    std::thread::scope(|scope| {
        let (started_tx, started_rx) = channel();
        let (finished_tx, finished_rx) = channel();
        let authority_ref = &authority;
        let contender = scope.spawn(move || {
            started_tx.send(()).expect("started signal");
            let committed = authority_ref
                .register(RegisterCommand::new(
                    HeadCas::new(0, GENESIS_SHA256.to_owned()),
                    value,
                ))
                .is_ok();
            finished_tx.send(committed).expect("finished signal");
        });
        started_rx.recv().expect("contender started");
        assert_eq!(
            finished_rx.recv_timeout(Duration::from_millis(50)),
            Err(RecvTimeoutError::Timeout)
        );
        refusal.attempt(reply).expect("locked refusal response");
        assert!(finished_rx.recv().expect("contender result"));
        contender.join().expect("contender join");
    });

    let mut response_bytes = vec![0_u8; crate::protocol::MAX_FRAME_BYTES];
    let (response_len, _) = recv(&client, &mut response_bytes, RecvFlags::empty())
        .expect("one complete refusal packet");
    response_bytes.truncate(response_len);
    assert_frame_type(&response_bytes, SUPERVISOR_REFUSAL);
    assert!(frame_text(&response_bytes).contains("\"code\": \"stale_compare_and_set\""));
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
    let register =
        encode_supervisor_response(SupervisorResponse::Register(RegisterSuccess::committed(
            DurableSuccess::synthetic(),
            1,
            transition.clone(),
            digest('2'),
            digest('3'),
            digest('4'),
            "2026-09-03T12:15:00.000Z".to_owned(),
        )))
        .expect("register response");
    assert_frame_type(register.as_bytes(), SUPERVISOR_REGISTER_SUCCESS);
    assert!(frame_text(register.as_bytes()).starts_with(
        "{\n  \"schemaVersion\": \"openspell.hosted-migration-root-register-success.v1\",\n  \"status\": \"committed\",\n"
    ));

    let statuses = [
        StatusResponse::Absent {
            proof: VerifiedStatus::synthetic(),
        },
        StatusResponse::Candidate {
            proof: VerifiedStatus::synthetic(),
            status: StatusAvailability::RecoveryOnly,
            generation: 1,
            transition_sha256: transition.clone(),
            candidate_sha256: digest('2'),
            candidate_binding_sha256: digest('3'),
            approval_challenge_sha256: digest('4'),
            cutoff_at: "2026-09-03T12:15:00Z".to_owned(),
        },
        StatusResponse::Approved {
            proof: VerifiedStatus::synthetic(),
            status: StatusAvailability::Available,
            generation: 2,
            transition_sha256: transition.clone(),
            approval_grant_sha256: digest('5'),
            approval_grant_signature_sha256: digest('6'),
            expires_at: "2026-09-03T12:15:00Z".to_owned(),
        },
        StatusResponse::Consumed {
            proof: VerifiedStatus::synthetic(),
            status: StatusAvailability::Available,
            generation: 3,
            transition_sha256: transition.clone(),
            execution_ticket_sha256: digest('7'),
            execution_ticket_signature_sha256: digest('8'),
            expires_at: "2026-09-03T12:15:00.000Z".to_owned(),
        },
        StatusResponse::CandidateExpired {
            proof: VerifiedStatus::synthetic(),
            status: StatusAvailability::Available,
            generation: 2,
            transition_sha256: transition.clone(),
            candidate_sha256: digest('2'),
        },
        StatusResponse::ApprovalExpired {
            proof: VerifiedStatus::synthetic(),
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

    let approve = encode_operator_response(OperatorResponse::Approve(ApproveSuccess::committed(
        DurableSuccess::synthetic(),
        2,
        transition.clone(),
        digest('5'),
        digest('6'),
        "2026-09-03T12:15:00Z".to_owned(),
    )))
    .expect("approve response");
    assert_frame_type(approve.as_bytes(), OPERATOR_APPROVE_SUCCESS);
    let close_candidate = encode_operator_response(OperatorResponse::CloseCandidate(
        CloseCandidateSuccess::committed(DurableSuccess::synthetic(), 2, transition.clone()),
    ))
    .expect("candidate close response");
    assert_frame_type(close_candidate.as_bytes(), OPERATOR_CLOSE_CANDIDATE_SUCCESS);
    let close_approval = encode_operator_response(OperatorResponse::CloseApproval(
        CloseApprovalSuccess::committed(DurableSuccess::synthetic(), 3, transition),
    ))
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
    let frame = encode_supervisor_response(SupervisorResponse::Consume(ConsumeSuccess::committed(
        DurableSuccess::synthetic(),
        3,
        digest('1'),
        ticket.encode().expect("ticket bytes").into_boxed_slice(),
        ticket_signature,
    )))
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
