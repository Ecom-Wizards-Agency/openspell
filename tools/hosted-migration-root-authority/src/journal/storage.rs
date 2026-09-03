//! Safe Linux fd-relative tree access and lifetime OFD locking.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CStr;
use std::mem::MaybeUninit;
use std::os::fd::OwnedFd;
use std::sync::{Mutex, MutexGuard};

use nix::fcntl::{FcntlArg, fcntl};
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, RawDir, ResolveFlags, Stat, fstat, fstatfs, fsync, openat2,
    statat,
};
use rustix::io::{Errno, read, write};
use sha2::{Digest as _, Sha256};

use super::{
    FORMAT_BYTES, InventoryFiles, MAX_CANONICAL_BYTES, MAX_LEAVES, MAX_SIGNATURES, MAX_TOTAL_BYTES,
    MAX_TRANSITIONS, TransitionFile, VerifiedSnapshot, VerifiedState, verify_inventory,
};
use crate::canonical::validate_whole_timestamp;
use crate::crypto::{RecordSigner, sha256_hex, verify_transition};
use crate::ipc::{IpcError, OperatorReply, SupervisorReply};
use crate::protocol::{
    ApproveSuccess, CloseApprovalSuccess, CloseCandidateSuccess, ConsumeSuccess, OperatorRefusal,
    OperatorRequestFamily, OperatorResponse, OperatorResponseFrame, RefusalCode, RegisterSuccess,
    StatusAvailability, StatusResponse, SupervisorRefusal, SupervisorRequestFamily,
    SupervisorResponse, SupervisorResponseFrame, encode_operator_response,
    encode_supervisor_response,
};
use crate::records::{Candidate, Transition};
use crate::state::{
    FreshAttendedAuthentication, RootVerifiedPreparedEnvelope, StateError, TransitionPlan,
    plan_approval, plan_approved_transition, plan_candidate_registered_transition,
    plan_close_approval_transition, plan_close_candidate_transition, plan_consumed_transition,
    plan_ticket, seal_candidate,
};

const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);
const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);
const CREATE_FLAGS: OFlags = OFlags::WRONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CREATE)
    .union(OFlags::EXCL);

const EXT_FAMILY_MAGIC: u64 = 0xef53;
const XFS_MAGIC: u64 = 0x5846_5342;
const TMPFS_MAGIC: u64 = 0x0102_1994;
const INCARNATION_DOMAIN: &[u8] = b"openspell.hosted-migration-authority-incarnation.v1\n";
const INVENTORY_DIGEST_DOMAIN: &[u8] = b"openspell.hosted-migration-inventory.v1\n";

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TestPublicationBoundary {
    FinalNameCreated,
    PartialWrite,
    CompleteWrite,
    MetadataVerified,
    FileSynced,
    DirectorySynced,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TestFaultPoint {
    BeforeFirstPublication,
    Publication {
        ordinal: usize,
        boundary: TestPublicationBoundary,
    },
    PostCommitVerified,
}

#[cfg(test)]
mod test_fault {
    use std::cell::{Cell, RefCell};

    use super::{TestFaultPoint, TestPublicationBoundary};

    pub(super) enum Action {
        ReturnError,
        ParkAt(Box<dyn FnOnce()>),
    }

    struct Fault {
        point: TestFaultPoint,
        action: Action,
    }

    std::thread_local! {
        static FAULT: RefCell<Option<Fault>> = const { RefCell::new(None) };
        static PUBLICATION_ORDINAL: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn set(point: TestFaultPoint, action: Action) {
        FAULT.with_borrow_mut(|slot| {
            assert!(
                slot.replace(Fault { point, action }).is_none(),
                "single test fault"
            );
        });
        PUBLICATION_ORDINAL.set(0);
    }

    pub(super) fn clear() {
        FAULT.with_borrow_mut(|slot| *slot = None);
        PUBLICATION_ORDINAL.set(0);
    }

    pub(super) fn armed() -> bool {
        FAULT.with_borrow(Option::is_some)
    }

    pub(super) fn next_publication() -> usize {
        PUBLICATION_ORDINAL.with(|ordinal| {
            let next = ordinal.get() + 1;
            ordinal.set(next);
            next
        })
    }

    pub(super) fn check(point: TestFaultPoint) -> Result<(), ()> {
        let action = FAULT.with_borrow_mut(|slot| {
            (slot.as_ref().map(|fault| fault.point) == Some(point))
                .then(|| slot.take().expect("matched test fault").action)
        });
        match action {
            None => Ok(()),
            Some(Action::ReturnError) => Err(()),
            Some(Action::ParkAt(signal)) => {
                signal();
                loop {
                    std::thread::park();
                }
            }
        }
    }

    pub(super) fn check_publication(
        ordinal: usize,
        boundary: TestPublicationBoundary,
    ) -> Result<(), ()> {
        check(TestFaultPoint::Publication { ordinal, boundary })
    }
}

#[cfg(test)]
pub(crate) fn test_fail_at(point: TestFaultPoint) {
    test_fault::set(point, test_fault::Action::ReturnError);
}

#[cfg(test)]
pub(crate) fn test_park_at(point: TestFaultPoint, signal: impl FnOnce() + 'static) {
    test_fault::set(point, test_fault::Action::ParkAt(Box::new(signal)));
}

#[cfg(test)]
pub(crate) fn test_clear_fault() {
    test_fault::clear();
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenError {
    Lock,
    Root,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StorageError {
    Sealed,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommitError {
    Build,
    Capacity,
    Clock,
    Collision,
    Entropy,
    Expired,
    InvalidState,
    NotExpired,
    Policy,
    RecoveryOnly,
    Sealed,
    Signer,
    Stale,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResponseAttemptError {
    Encode,
    Send(IpcError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Health {
    Available,
    RecoveredNonterminal,
    Sealed,
}

pub(crate) struct HeadCas {
    generation: u64,
    transition_sha256: String,
}

impl HeadCas {
    pub(crate) fn new(generation: u64, transition_sha256: String) -> Self {
        Self {
            generation,
            transition_sha256,
        }
    }
}

pub(crate) struct RegisterCommand {
    head: HeadCas,
    candidate: Candidate,
}

impl RegisterCommand {
    pub(crate) fn new(head: HeadCas, candidate: Candidate) -> Self {
        Self { head, candidate }
    }
}

pub(crate) struct ApproveCommand {
    head: HeadCas,
    operation_id: String,
    authorization_nonce: String,
    envelope_sha256: String,
    action_challenge_sha256: String,
}

pub(crate) struct StatusCommand {
    operation_id: String,
}

impl StatusCommand {
    pub(crate) fn new(operation_id: String) -> Self {
        Self { operation_id }
    }
}

impl ApproveCommand {
    pub(crate) fn new(
        head: HeadCas,
        operation_id: String,
        authorization_nonce: String,
        envelope_sha256: String,
        action_challenge_sha256: String,
    ) -> Self {
        Self {
            head,
            operation_id,
            authorization_nonce,
            envelope_sha256,
            action_challenge_sha256,
        }
    }
}

pub(crate) struct ConsumeCommand {
    head: HeadCas,
    operation_id: String,
    authorization_nonce: String,
    grant_sha256: String,
    grant_signature_sha256: String,
}

impl ConsumeCommand {
    pub(crate) fn new(
        head: HeadCas,
        operation_id: String,
        authorization_nonce: String,
        grant_sha256: String,
        grant_signature_sha256: String,
    ) -> Self {
        Self {
            head,
            operation_id,
            authorization_nonce,
            grant_sha256,
            grant_signature_sha256,
        }
    }
}

pub(crate) struct CloseCandidateCommand {
    head: HeadCas,
    operation_id: String,
    authorization_nonce: String,
    envelope_sha256: String,
    action_challenge_sha256: String,
}

impl CloseCandidateCommand {
    pub(crate) fn new(
        head: HeadCas,
        operation_id: String,
        authorization_nonce: String,
        envelope_sha256: String,
        action_challenge_sha256: String,
    ) -> Self {
        Self {
            head,
            operation_id,
            authorization_nonce,
            envelope_sha256,
            action_challenge_sha256,
        }
    }
}

pub(crate) struct CloseApprovalCommand {
    head: HeadCas,
    operation_id: String,
    authorization_nonce: String,
    envelope_sha256: String,
    grant_sha256: String,
    grant_signature_sha256: String,
    action_challenge_sha256: String,
}

impl CloseApprovalCommand {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        head: HeadCas,
        operation_id: String,
        authorization_nonce: String,
        envelope_sha256: String,
        grant_sha256: String,
        grant_signature_sha256: String,
        action_challenge_sha256: String,
    ) -> Self {
        Self {
            head,
            operation_id,
            authorization_nonce,
            envelope_sha256,
            grant_sha256,
            grant_signature_sha256,
            action_challenge_sha256,
        }
    }
}

pub(crate) trait TrustedClock {
    fn sample(&self) -> Result<String, ()>;
}

pub(crate) trait TicketEntropy {
    fn draw_once(&self) -> Result<[u8; 32], ()>;
}

struct ContentObject {
    bytes: Vec<u8>,
    digest: String,
}

impl ContentObject {
    fn leaf(bytes: Vec<u8>) -> Result<Self, CommitError> {
        if bytes.is_empty() || bytes.len() > MAX_CANONICAL_BYTES {
            return Err(CommitError::Build);
        }
        Ok(Self {
            digest: sha256_hex(&bytes),
            bytes,
        })
    }
}

struct SignedLeaf {
    signature: [u8; 64],
    signature_sha256: String,
    leaf: ContentObject,
}

impl SignedLeaf {
    fn new(bytes: Vec<u8>, signature: [u8; 64]) -> Result<Self, CommitError> {
        Ok(Self {
            signature_sha256: sha256_hex(&signature),
            signature,
            leaf: ContentObject::leaf(bytes)?,
        })
    }
}

enum ArtifactPublication {
    None,
    Candidate(ContentObject),
    Signed(SignedLeaf),
}

impl ArtifactPublication {
    fn footprint(&self, transition_bytes: usize) -> Result<Footprint, CommitError> {
        let (leaves, signatures, bytes) = match self {
            Self::None => (0, 1, 64),
            Self::Candidate(leaf) => (1, 1, leaf.bytes.len() + 64),
            Self::Signed(signed) => (1, 2, signed.leaf.bytes.len() + 128),
        };
        Ok(Footprint {
            leaves,
            signatures,
            transitions: 1,
            bytes: bytes
                .checked_add(transition_bytes)
                .ok_or(CommitError::Capacity)?,
        })
    }
}

struct Footprint {
    leaves: usize,
    signatures: usize,
    transitions: usize,
    bytes: usize,
}

struct PreparedTransition {
    signature: [u8; 64],
    signature_sha256: String,
    bytes: Vec<u8>,
    sha256: String,
    name: String,
}

struct CompleteInventory {
    inventory: InventoryFiles,
    snapshot: VerifiedSnapshot,
    total_bytes: usize,
    identities: BTreeMap<String, FileIdentity>,
    digest: [u8; 32],
}

struct InventoryRevalidation {
    total_bytes: usize,
    identities: BTreeMap<String, FileIdentity>,
    digest: [u8; 32],
}

#[derive(Eq, PartialEq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    mode: u32,
    nlink: u64,
    uid: u32,
    gid: u32,
    size: i64,
    mtime: i64,
    mtime_nsec: u64,
    ctime: i64,
    ctime_nsec: u64,
}

impl From<&Stat> for FileIdentity {
    fn from(stat: &Stat) -> Self {
        Self {
            dev: stat.st_dev,
            ino: stat.st_ino,
            mode: stat.st_mode,
            nlink: stat.st_nlink,
            uid: stat.st_uid,
            gid: stat.st_gid,
            size: stat.st_size,
            mtime: stat.st_mtime,
            mtime_nsec: stat.st_mtime_nsec,
            ctime: stat.st_ctime,
            ctime_nsec: stat.st_ctime_nsec,
        }
    }
}

struct CommitCore {
    generation: u64,
    transition_sha256: String,
}

enum SupervisorReceipt {
    Registered {
        proof: super::DurableSuccess,
        core: CommitCore,
        candidate_sha256: String,
        candidate_binding_sha256: String,
        approval_challenge_sha256: String,
        cutoff_at: String,
    },
    Consumed {
        proof: super::DurableSuccess,
        core: CommitCore,
        ticket_bytes: Box<[u8]>,
        ticket_signature: [u8; 64],
    },
}

enum OperatorReceipt {
    Approved {
        proof: super::DurableSuccess,
        core: CommitCore,
        grant_sha256: String,
        grant_signature_sha256: String,
        expires_at: String,
    },
    CandidateExpired {
        proof: super::DurableSuccess,
        core: CommitCore,
    },
    ApprovalExpired {
        proof: super::DurableSuccess,
        core: CommitCore,
    },
}

pub(crate) struct LockedSupervisorCommit<'a> {
    guard: MutexGuard<'a, Health>,
    family: SupervisorRequestFamily,
    outcome: Option<Result<SupervisorReceipt, CommitError>>,
}

pub(crate) struct LockedOperatorCommit<'a> {
    guard: MutexGuard<'a, Health>,
    family: OperatorRequestFamily,
    outcome: Option<Result<OperatorReceipt, CommitError>>,
}

enum StatusProjection {
    Absent {
        proof: super::VerifiedStatus,
    },
    Candidate {
        proof: super::VerifiedStatus,
        availability: StatusMode,
        core: CommitCore,
        candidate_sha256: String,
        candidate_binding_sha256: String,
        approval_challenge_sha256: String,
        cutoff_at: String,
    },
    Approved {
        proof: super::VerifiedStatus,
        availability: StatusMode,
        core: CommitCore,
        grant_sha256: String,
        grant_signature_sha256: String,
        expires_at: String,
    },
    Consumed {
        proof: super::VerifiedStatus,
        availability: StatusMode,
        core: CommitCore,
        ticket_sha256: String,
        ticket_signature_sha256: String,
        expires_at: String,
    },
    CandidateExpired {
        proof: super::VerifiedStatus,
        availability: StatusMode,
        core: CommitCore,
        candidate_sha256: String,
    },
    ApprovalExpired {
        proof: super::VerifiedStatus,
        availability: StatusMode,
        core: CommitCore,
        grant_sha256: String,
        grant_signature_sha256: String,
    },
}

#[derive(Clone, Copy)]
enum StatusMode {
    Available,
    RecoveryOnly,
}

pub(crate) struct LockedSupervisorStatus<'a> {
    guard: MutexGuard<'a, Health>,
    outcome: Option<Result<StatusProjection, CommitError>>,
}

impl LockedSupervisorCommit<'_> {
    fn encode_response(&mut self) -> Result<SupervisorResponseFrame, ResponseAttemptError> {
        let response = match self.outcome.take().expect("single supervisor outcome") {
            Ok(SupervisorReceipt::Registered {
                proof,
                core,
                candidate_sha256,
                candidate_binding_sha256,
                approval_challenge_sha256,
                cutoff_at,
            }) => SupervisorResponse::Register(RegisterSuccess::committed(
                proof,
                core.generation,
                core.transition_sha256,
                candidate_sha256,
                candidate_binding_sha256,
                approval_challenge_sha256,
                cutoff_at,
            )),
            Ok(SupervisorReceipt::Consumed {
                proof,
                core,
                ticket_bytes,
                ticket_signature,
            }) => SupervisorResponse::Consume(ConsumeSuccess::committed(
                proof,
                core.generation,
                core.transition_sha256,
                ticket_bytes,
                ticket_signature,
            )),
            Err(error) => SupervisorResponse::Refusal(SupervisorRefusal {
                family: self.family,
                code: refusal_code(error),
            }),
        };
        encode_supervisor_response(response).map_err(|_| {
            *self.guard = Health::Sealed;
            ResponseAttemptError::Encode
        })
    }

    pub(crate) fn attempt(mut self, reply: SupervisorReply) -> Result<(), ResponseAttemptError> {
        let frame = self.encode_response()?;
        reply.send(frame).map_err(ResponseAttemptError::Send)
    }

    #[cfg(test)]
    pub(crate) fn attempt_prefix_for_test(
        mut self,
        reply: SupervisorReply,
        prefix_len: usize,
    ) -> Result<(), ResponseAttemptError> {
        let frame = self.encode_response()?;
        reply
            .send_prefix_for_test(frame, prefix_len)
            .map_err(ResponseAttemptError::Send)
    }
}

impl LockedOperatorCommit<'_> {
    fn encode_response(&mut self) -> Result<OperatorResponseFrame, ResponseAttemptError> {
        let response = match self.outcome.take().expect("single operator outcome") {
            Ok(OperatorReceipt::Approved {
                proof,
                core,
                grant_sha256,
                grant_signature_sha256,
                expires_at,
            }) => OperatorResponse::Approve(ApproveSuccess::committed(
                proof,
                core.generation,
                core.transition_sha256,
                grant_sha256,
                grant_signature_sha256,
                expires_at,
            )),
            Ok(OperatorReceipt::CandidateExpired { proof, core }) => {
                OperatorResponse::CloseCandidate(CloseCandidateSuccess::committed(
                    proof,
                    core.generation,
                    core.transition_sha256,
                ))
            }
            Ok(OperatorReceipt::ApprovalExpired { proof, core }) => {
                OperatorResponse::CloseApproval(CloseApprovalSuccess::committed(
                    proof,
                    core.generation,
                    core.transition_sha256,
                ))
            }
            Err(error) => OperatorResponse::Refusal(OperatorRefusal {
                family: self.family,
                code: refusal_code(error),
            }),
        };
        encode_operator_response(response).map_err(|_| {
            *self.guard = Health::Sealed;
            ResponseAttemptError::Encode
        })
    }

    pub(crate) fn attempt(mut self, reply: OperatorReply) -> Result<(), ResponseAttemptError> {
        let frame = self.encode_response()?;
        reply.send(frame).map_err(ResponseAttemptError::Send)
    }

    #[cfg(test)]
    pub(crate) fn attempt_prefix_for_test(
        mut self,
        reply: OperatorReply,
        prefix_len: usize,
    ) -> Result<(), ResponseAttemptError> {
        let frame = self.encode_response()?;
        reply
            .send_prefix_for_test(frame, prefix_len)
            .map_err(ResponseAttemptError::Send)
    }
}

#[cfg(test)]
impl LockedSupervisorStatus<'_> {
    pub(crate) fn test_snapshot(&self) -> (&'static str, Option<u64>, Option<&str>) {
        match self
            .outcome
            .as_ref()
            .expect("status outcome")
            .as_ref()
            .expect("verified status")
        {
            StatusProjection::Absent { .. } => ("absent", None, None),
            StatusProjection::Candidate { core, .. } => (
                "candidate_registered",
                Some(core.generation),
                Some(&core.transition_sha256),
            ),
            StatusProjection::Approved { core, .. } => (
                "approved",
                Some(core.generation),
                Some(&core.transition_sha256),
            ),
            StatusProjection::Consumed { core, .. } => (
                "consumed",
                Some(core.generation),
                Some(&core.transition_sha256),
            ),
            StatusProjection::CandidateExpired { core, .. } => (
                "candidate_expired",
                Some(core.generation),
                Some(&core.transition_sha256),
            ),
            StatusProjection::ApprovalExpired { core, .. } => (
                "approval_expired",
                Some(core.generation),
                Some(&core.transition_sha256),
            ),
        }
    }
}

impl LockedSupervisorStatus<'_> {
    pub(crate) fn attempt(mut self, reply: SupervisorReply) -> Result<(), ResponseAttemptError> {
        let status = match self.outcome.take().expect("single status outcome") {
            Err(error) => {
                let response = SupervisorResponse::Refusal(SupervisorRefusal {
                    family: SupervisorRequestFamily::Status,
                    code: refusal_code(error),
                });
                let frame = match encode_supervisor_response(response) {
                    Ok(frame) => frame,
                    Err(_) => {
                        *self.guard = Health::Sealed;
                        return Err(ResponseAttemptError::Encode);
                    }
                };
                return reply.send(frame).map_err(ResponseAttemptError::Send);
            }
            Ok(projection) => match projection {
                StatusProjection::Absent { proof } => StatusResponse::absent(proof),
                StatusProjection::Candidate {
                    proof,
                    availability,
                    core,
                    candidate_sha256,
                    candidate_binding_sha256,
                    approval_challenge_sha256,
                    cutoff_at,
                } => StatusResponse::Candidate {
                    proof,
                    status: status_availability(availability),
                    generation: core.generation,
                    transition_sha256: core.transition_sha256,
                    candidate_sha256,
                    candidate_binding_sha256,
                    approval_challenge_sha256,
                    cutoff_at,
                },
                StatusProjection::Approved {
                    proof,
                    availability,
                    core,
                    grant_sha256,
                    grant_signature_sha256,
                    expires_at,
                } => StatusResponse::Approved {
                    proof,
                    status: status_availability(availability),
                    generation: core.generation,
                    transition_sha256: core.transition_sha256,
                    approval_grant_sha256: grant_sha256,
                    approval_grant_signature_sha256: grant_signature_sha256,
                    expires_at,
                },
                StatusProjection::Consumed {
                    proof,
                    availability,
                    core,
                    ticket_sha256,
                    ticket_signature_sha256,
                    expires_at,
                } => StatusResponse::Consumed {
                    proof,
                    status: status_availability(availability),
                    generation: core.generation,
                    transition_sha256: core.transition_sha256,
                    execution_ticket_sha256: ticket_sha256,
                    execution_ticket_signature_sha256: ticket_signature_sha256,
                    expires_at,
                },
                StatusProjection::CandidateExpired {
                    proof,
                    availability,
                    core,
                    candidate_sha256,
                } => StatusResponse::CandidateExpired {
                    proof,
                    status: status_availability(availability),
                    generation: core.generation,
                    transition_sha256: core.transition_sha256,
                    candidate_sha256,
                },
                StatusProjection::ApprovalExpired {
                    proof,
                    availability,
                    core,
                    grant_sha256,
                    grant_signature_sha256,
                } => StatusResponse::ApprovalExpired {
                    proof,
                    status: status_availability(availability),
                    generation: core.generation,
                    transition_sha256: core.transition_sha256,
                    approval_grant_sha256: grant_sha256,
                    approval_grant_signature_sha256: grant_signature_sha256,
                },
            },
        };
        let frame = match encode_supervisor_response(SupervisorResponse::Status(status)) {
            Ok(frame) => frame,
            Err(_) => {
                *self.guard = Health::Sealed;
                return Err(ResponseAttemptError::Encode);
            }
        };
        reply.send(frame).map_err(ResponseAttemptError::Send)
    }
}

fn status_availability(status: StatusMode) -> StatusAvailability {
    match status {
        StatusMode::RecoveryOnly => StatusAvailability::RecoveryOnly,
        StatusMode::Available => StatusAvailability::Available,
    }
}

#[cfg(test)]
impl LockedSupervisorCommit<'_> {
    pub(crate) fn test_snapshot(&self) -> (&'static str, u64, &str) {
        match self
            .outcome
            .as_ref()
            .expect("outcome")
            .as_ref()
            .expect("committed outcome")
        {
            SupervisorReceipt::Registered { core, .. } => (
                "candidate_registered",
                core.generation,
                &core.transition_sha256,
            ),
            SupervisorReceipt::Consumed { core, .. } => {
                ("consumed", core.generation, &core.transition_sha256)
            }
        }
    }
}

#[cfg(test)]
impl LockedOperatorCommit<'_> {
    pub(crate) fn test_snapshot(&self) -> (&'static str, u64, &str) {
        match self
            .outcome
            .as_ref()
            .expect("outcome")
            .as_ref()
            .expect("committed outcome")
        {
            OperatorReceipt::Approved { core, .. } => {
                ("approved", core.generation, &core.transition_sha256)
            }
            OperatorReceipt::CandidateExpired { core, .. } => (
                "candidate_expired",
                core.generation,
                &core.transition_sha256,
            ),
            OperatorReceipt::ApprovalExpired { core, .. } => {
                ("approval_expired", core.generation, &core.transition_sha256)
            }
        }
    }
}

#[cfg(test)]
impl LockedSupervisorCommit<'_> {
    pub(crate) fn expect(self, message: &str) -> Self {
        assert!(
            self.outcome.as_ref().is_some_and(Result::is_ok),
            "{message}"
        );
        self
    }

    pub(crate) fn is_ok(&self) -> bool {
        self.outcome.as_ref().is_some_and(Result::is_ok)
    }

    pub(crate) fn test_error(&self) -> Option<CommitError> {
        self.outcome
            .as_ref()
            .and_then(|outcome| outcome.as_ref().err().copied())
    }
}

#[cfg(test)]
impl LockedOperatorCommit<'_> {
    pub(crate) fn expect(self, message: &str) -> Self {
        assert!(
            self.outcome.as_ref().is_some_and(Result::is_ok),
            "{message}"
        );
        self
    }

    pub(crate) fn is_ok(&self) -> bool {
        self.outcome.as_ref().is_some_and(Result::is_ok)
    }

    pub(crate) fn test_error(&self) -> Option<CommitError> {
        self.outcome
            .as_ref()
            .and_then(|outcome| outcome.as_ref().err().copied())
    }
}

#[cfg(test)]
impl LockedSupervisorStatus<'_> {
    pub(crate) fn expect(self, message: &str) -> Self {
        assert!(
            self.outcome.as_ref().is_some_and(Result::is_ok),
            "{message}"
        );
        self
    }

    pub(crate) fn test_error(&self) -> Option<CommitError> {
        self.outcome
            .as_ref()
            .and_then(|outcome| outcome.as_ref().err().copied())
    }

    pub(crate) fn test_availability(&self) -> Option<&'static str> {
        let projection = self.outcome.as_ref()?.as_ref().ok()?;
        let mode = match projection {
            StatusProjection::Absent { .. } => return None,
            StatusProjection::Candidate { availability, .. }
            | StatusProjection::Approved { availability, .. }
            | StatusProjection::Consumed { availability, .. }
            | StatusProjection::CandidateExpired { availability, .. }
            | StatusProjection::ApprovalExpired { availability, .. } => availability,
        };
        Some(match mode {
            StatusMode::Available => "available",
            StatusMode::RecoveryOnly => "recovery_only",
        })
    }
}

pub(crate) struct RootAuthority<S, C, E> {
    store: JournalStore,
    signer: S,
    clock: C,
    entropy: E,
    incarnation_sha256: String,
}

#[cfg(test)]
impl<S, C, E> RootAuthority<S, C, E> {
    pub(crate) fn synthetic(
        store: JournalStore,
        signer: S,
        clock: C,
        entropy: E,
    ) -> Result<Self, CommitError>
    where
        E: TicketEntropy,
    {
        let complete = store
            .scan_complete()
            .map_err(|()| CommitError::Unavailable)?;
        let raw_incarnation = entropy.draw_once().map_err(|()| CommitError::Entropy)?;
        let mut incarnation_preimage = Vec::with_capacity(INCARNATION_DOMAIN.len() + 32);
        incarnation_preimage.extend_from_slice(INCARNATION_DOMAIN);
        incarnation_preimage.extend_from_slice(&raw_incarnation);
        let incarnation_sha256 = sha256_hex(&incarnation_preimage);
        if authority_incarnation_used(&complete, &incarnation_sha256) {
            return Err(CommitError::Collision);
        }
        Ok(Self {
            store,
            signer,
            clock,
            entropy,
            incarnation_sha256,
        })
    }

    #[cfg(test)]
    pub(crate) fn inspect(&self) -> Result<(Health, VerifiedSnapshot), StorageError> {
        self.store.inspect()
    }
}

struct PublicationEpoch<'a> {
    health: &'a mut Health,
    completed: bool,
}

impl PublicationEpoch<'_> {
    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for PublicationEpoch<'_> {
    fn drop(&mut self) {
        if !self.completed {
            *self.health = Health::Sealed;
        }
    }
}

#[derive(Clone, Copy)]
struct Owner {
    uid: u32,
    gid: u32,
    dev: u64,
}

struct JournalFds {
    root: OwnedFd,
    objects: OwnedFd,
    leaves: OwnedFd,
    signatures: OwnedFd,
    transitions: OwnedFd,
    format: OwnedFd,
    lock: OwnedFd,
}

pub(crate) struct JournalStore {
    fds: JournalFds,
    owner: Owner,
    pinned_public_key: [u8; 32],
    gate: Mutex<Health>,
}

impl JournalStore {
    fn lock_health(&self) -> MutexGuard<'_, Health> {
        match self.gate.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = Health::Sealed;
                guard
            }
        }
    }

    pub(crate) fn open_from_fd(
        root: OwnedFd,
        expected_uid: u32,
        expected_gid: u32,
        pinned_public_key: [u8; 32],
    ) -> Result<Self, OpenError> {
        let root_stat = fstat(&root).map_err(|_| OpenError::Root)?;
        let owner = Owner {
            uid: expected_uid,
            gid: expected_gid,
            dev: root_stat.st_dev,
        };
        verify_directory(&root_stat, owner, 0o700, 4).map_err(|_| OpenError::Root)?;
        verify_local_filesystem(&root).map_err(|_| OpenError::Root)?;
        let lock = open_regular(&root, c"LOCK", owner, 0, true).map_err(|_| OpenError::Root)?;
        acquire_ofd_lock(&lock).map_err(|_| OpenError::Lock)?;
        verify_entry_matches_fd(
            &root,
            c"LOCK",
            &lock,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )
        .map_err(|_| OpenError::Root)?;

        require_names(&root, &["FORMAT", "LOCK", "objects", "transitions"])
            .map_err(|_| OpenError::Root)?;

        let objects = open_directory(&root, c"objects", owner, 4).map_err(|_| OpenError::Root)?;
        require_names(&objects, &["leaves", "signatures"]).map_err(|_| OpenError::Root)?;
        let leaves = open_directory(&objects, c"leaves", owner, 2).map_err(|_| OpenError::Root)?;
        let signatures =
            open_directory(&objects, c"signatures", owner, 2).map_err(|_| OpenError::Root)?;
        let transitions =
            open_directory(&root, c"transitions", owner, 2).map_err(|_| OpenError::Root)?;

        let format = open_regular(&root, c"FORMAT", owner, FORMAT_BYTES.len(), false)
            .map_err(|_| OpenError::Root)?;
        if read_exact_file(&format, FORMAT_BYTES.len()).map_err(|_| OpenError::Root)?
            != FORMAT_BYTES
        {
            return Err(OpenError::Root);
        }
        let store = Self {
            fds: JournalFds {
                root,
                objects,
                leaves,
                signatures,
                transitions,
                format,
                lock,
            },
            owner,
            pinned_public_key,
            gate: Mutex::new(Health::Available),
        };
        let initial = store.scan();
        let health = match initial {
            Ok(snapshot) if snapshot.state.is_nonterminal() => Health::RecoveredNonterminal,
            Ok(_) => Health::Available,
            Err(_) => Health::Sealed,
        };
        *store.gate.lock().map_err(|_| OpenError::Root)? = health;
        Ok(store)
    }

    #[cfg(test)]
    pub(crate) fn inspect(&self) -> Result<(Health, VerifiedSnapshot), StorageError> {
        let mut health = self.gate.lock().map_err(|_| StorageError::Unavailable)?;
        if *health == Health::Sealed {
            return Err(StorageError::Sealed);
        }
        match self.scan() {
            Ok(snapshot) => Ok((*health, snapshot)),
            Err(_) => {
                *health = Health::Sealed;
                Err(StorageError::Unavailable)
            }
        }
    }

    fn begin(
        &self,
        guard: &mut MutexGuard<'_, Health>,
        head: &HeadCas,
        closure: bool,
    ) -> Result<CompleteInventory, CommitError> {
        if **guard == Health::Sealed {
            return Err(CommitError::Sealed);
        }
        let complete = match self.scan_complete() {
            Ok(complete) => complete,
            Err(()) => {
                **guard = Health::Sealed;
                return Err(CommitError::Unavailable);
            }
        };
        let revalidated = match self.scan_revalidation() {
            Ok(revalidated) => revalidated,
            Err(()) => {
                **guard = Health::Sealed;
                return Err(CommitError::Unavailable);
            }
        };
        if revalidated.total_bytes != complete.total_bytes
            || revalidated.identities != complete.identities
            || revalidated.digest != complete.digest
        {
            **guard = Health::Sealed;
            return Err(CommitError::Unavailable);
        }
        if **guard == Health::RecoveredNonterminal && !closure {
            return Err(CommitError::RecoveryOnly);
        }
        if complete.snapshot.generation != head.generation
            || complete.snapshot.transition_sha256 != head.transition_sha256
        {
            return Err(CommitError::Stale);
        }
        Ok(complete)
    }

    #[allow(clippy::too_many_arguments)]
    fn publish_successor<F>(
        &self,
        guard: &mut MutexGuard<'_, Health>,
        complete: CompleteInventory,
        artifact: ArtifactPublication,
        transition_plan: TransitionPlan,
        expected_transition_bytes: usize,
        signer: &impl RecordSigner,
        expected_successor: F,
    ) -> Result<(VerifiedSnapshot, super::DurableSuccess), CommitError>
    where
        F: FnOnce(&VerifiedSnapshot) -> bool,
    {
        let footprint = artifact.footprint(expected_transition_bytes)?;
        validate_projection(&complete, &footprint)?;
        validate_artifact_names(&complete, &artifact)?;

        let mut transition_plan = Some(transition_plan);
        let pre_publication_transition = if matches!(artifact, ArtifactPublication::None) {
            Some(prepare_transition(
                transition_plan.take().expect("single transition plan"),
                expected_transition_bytes,
                signer,
                &self.pinned_public_key,
                &complete,
                &artifact,
            )?)
        } else {
            None
        };

        #[cfg(test)]
        test_fault::check(TestFaultPoint::BeforeFirstPublication)
            .map_err(|()| CommitError::Unavailable)?;
        let mut epoch = PublicationEpoch {
            health: guard,
            completed: false,
        };
        match &artifact {
            ArtifactPublication::None => {}
            ArtifactPublication::Candidate(leaf) => {
                publish(&self.fds.leaves, &leaf.digest, &leaf.bytes, self.owner)
                    .map_err(|()| CommitError::Unavailable)?;
            }
            ArtifactPublication::Signed(signed) => {
                publish(
                    &self.fds.signatures,
                    &signed.signature_sha256,
                    &signed.signature,
                    self.owner,
                )
                .map_err(|()| CommitError::Unavailable)?;
                publish(
                    &self.fds.leaves,
                    &signed.leaf.digest,
                    &signed.leaf.bytes,
                    self.owner,
                )
                .map_err(|()| CommitError::Unavailable)?;
            }
        }

        let transition = match pre_publication_transition {
            Some(prepared) => prepared,
            None => prepare_transition(
                transition_plan.take().expect("single transition plan"),
                expected_transition_bytes,
                signer,
                &self.pinned_public_key,
                &complete,
                &artifact,
            )
            .map_err(|_| CommitError::Unavailable)?,
        };
        publish(
            &self.fds.signatures,
            &transition.signature_sha256,
            &transition.signature,
            self.owner,
        )
        .map_err(|()| CommitError::Unavailable)?;

        publish(
            &self.fds.transitions,
            &transition.name,
            &transition.bytes,
            self.owner,
        )
        .map_err(|()| CommitError::Unavailable)?;

        let committed_generation = complete
            .snapshot
            .generation
            .checked_add(1)
            .ok_or(CommitError::Capacity)?;
        drop(complete);
        let committed = self
            .scan_complete()
            .map_err(|()| CommitError::Unavailable)?;
        if committed.snapshot.generation != committed_generation
            || committed.snapshot.transition_sha256 != transition.sha256
            || !expected_successor(&committed.snapshot)
        {
            return Err(CommitError::Unavailable);
        }
        #[cfg(test)]
        test_fault::check(TestFaultPoint::PostCommitVerified)
            .map_err(|()| CommitError::Unavailable)?;
        epoch.complete();
        drop(epoch);
        Ok((committed.snapshot, super::DurableSuccess::verified()))
    }

    fn scan(&self) -> Result<VerifiedSnapshot, ()> {
        Ok(self.scan_complete()?.snapshot)
    }

    fn scan_complete(&self) -> Result<CompleteInventory, ()> {
        self.verify_tree_shape()?;
        let mut digest = inventory_digest();
        let mut total_bytes = FORMAT_BYTES.len();
        let mut identities = BTreeMap::new();
        let leaves = scan_objects(
            &self.fds.leaves,
            self.owner,
            MAX_LEAVES,
            false,
            "leaves",
            &mut total_bytes,
            &mut identities,
            &mut digest,
        )?;
        let signatures = scan_objects(
            &self.fds.signatures,
            self.owner,
            MAX_SIGNATURES,
            true,
            "signatures",
            &mut total_bytes,
            &mut identities,
            &mut digest,
        )?;
        let transitions = scan_transitions(
            &self.fds.transitions,
            self.owner,
            &mut total_bytes,
            &mut identities,
            &mut digest,
        )?;
        let inventory = InventoryFiles {
            leaves,
            signatures,
            transitions,
        };
        let snapshot = verify_inventory(&inventory, &self.pinned_public_key).map_err(|_| ())?;
        Ok(CompleteInventory {
            inventory,
            snapshot,
            total_bytes,
            identities,
            digest: digest.finalize().into(),
        })
    }

    fn scan_revalidation(&self) -> Result<InventoryRevalidation, ()> {
        self.verify_tree_shape()?;
        let mut digest = inventory_digest();
        let mut total_bytes = FORMAT_BYTES.len();
        let mut identities = BTreeMap::new();
        scan_objects_revalidation(
            &self.fds.leaves,
            self.owner,
            MAX_LEAVES,
            false,
            "leaves",
            &mut total_bytes,
            &mut identities,
            &mut digest,
        )?;
        scan_objects_revalidation(
            &self.fds.signatures,
            self.owner,
            MAX_SIGNATURES,
            true,
            "signatures",
            &mut total_bytes,
            &mut identities,
            &mut digest,
        )?;
        scan_transitions_revalidation(
            &self.fds.transitions,
            self.owner,
            &mut total_bytes,
            &mut identities,
            &mut digest,
        )?;
        Ok(InventoryRevalidation {
            total_bytes,
            identities,
            digest: digest.finalize().into(),
        })
    }

    fn verify_tree_shape(&self) -> Result<(), ()> {
        verify_directory(
            &fstat(&self.fds.root).map_err(|_| ())?,
            self.owner,
            0o700,
            4,
        )?;
        verify_local_filesystem(&self.fds.root)?;
        require_names(
            &self.fds.root,
            &["FORMAT", "LOCK", "objects", "transitions"],
        )?;
        verify_entry_matches_fd(
            &self.fds.root,
            c"objects",
            &self.fds.objects,
            self.owner,
            FileType::Directory,
            0o700,
            4,
        )?;
        require_names(&self.fds.objects, &["leaves", "signatures"])?;
        verify_entry_matches_fd(
            &self.fds.objects,
            c"leaves",
            &self.fds.leaves,
            self.owner,
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            &self.fds.objects,
            c"signatures",
            &self.fds.signatures,
            self.owner,
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            &self.fds.root,
            c"transitions",
            &self.fds.transitions,
            self.owner,
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            &self.fds.root,
            c"FORMAT",
            &self.fds.format,
            self.owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if read_exact_file(&self.fds.format, FORMAT_BYTES.len())? != FORMAT_BYTES {
            return Err(());
        }
        verify_entry_matches_fd(
            &self.fds.root,
            c"LOCK",
            &self.fds.lock,
            self.owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if fstat(&self.fds.lock).map_err(|_| ())?.st_size != 0 {
            return Err(());
        }
        Ok(())
    }
}

impl<S, C, E> RootAuthority<S, C, E>
where
    S: RecordSigner,
    C: TrustedClock,
    E: TicketEntropy,
{
    pub(crate) fn status(&self, command: StatusCommand) -> LockedSupervisorStatus<'_> {
        let mut guard = self.store.lock_health();
        let outcome = (|| -> Result<StatusProjection, CommitError> {
            if *guard == Health::Sealed {
                return Err(CommitError::Sealed);
            }
            let complete = match self.store.scan_complete() {
                Ok(complete) => complete,
                Err(()) => {
                    *guard = Health::Sealed;
                    return Err(CommitError::Unavailable);
                }
            };
            let projection = match complete.snapshot.operations.get(&command.operation_id) {
                None => StatusProjection::Absent {
                    proof: super::VerifiedStatus::verified(),
                },
                Some(operation) => {
                    let availability = match *guard {
                        Health::Available => StatusMode::Available,
                        Health::RecoveredNonterminal => StatusMode::RecoveryOnly,
                        Health::Sealed => return Err(CommitError::Sealed),
                    };
                    let core = CommitCore {
                        generation: operation.generation,
                        transition_sha256: operation.transition_sha256.clone(),
                    };
                    match &operation.state {
                        VerifiedState::Empty => return Err(CommitError::Unavailable),
                        VerifiedState::CandidateRegistered {
                            candidate_sha256,
                            candidate,
                        } => StatusProjection::Candidate {
                            proof: super::VerifiedStatus::verified(),
                            availability,
                            core,
                            candidate_sha256: candidate_sha256.clone(),
                            candidate_binding_sha256: candidate.candidate_binding_sha256.clone(),
                            approval_challenge_sha256: candidate.approval_challenge_sha256.clone(),
                            cutoff_at: candidate.cutoff_at.clone(),
                        },
                        VerifiedState::Approved {
                            grant_sha256,
                            grant_signature_sha256,
                            grant,
                            ..
                        } => StatusProjection::Approved {
                            proof: super::VerifiedStatus::verified(),
                            availability,
                            core,
                            grant_sha256: grant_sha256.clone(),
                            grant_signature_sha256: grant_signature_sha256.clone(),
                            expires_at: grant.expires_at.clone(),
                        },
                        VerifiedState::Consumed {
                            ticket_sha256,
                            ticket_signature_sha256,
                            ticket,
                            ..
                        } => StatusProjection::Consumed {
                            proof: super::VerifiedStatus::verified(),
                            availability,
                            core,
                            ticket_sha256: ticket_sha256.clone(),
                            ticket_signature_sha256: ticket_signature_sha256.clone(),
                            expires_at: ticket.expires_at.clone(),
                        },
                        VerifiedState::CandidateExpired {
                            candidate_sha256, ..
                        } => StatusProjection::CandidateExpired {
                            proof: super::VerifiedStatus::verified(),
                            availability,
                            core,
                            candidate_sha256: candidate_sha256.clone(),
                        },
                        VerifiedState::ApprovalExpired {
                            grant_sha256,
                            grant_signature_sha256,
                            ..
                        } => StatusProjection::ApprovalExpired {
                            proof: super::VerifiedStatus::verified(),
                            availability,
                            core,
                            grant_sha256: grant_sha256.clone(),
                            grant_signature_sha256: grant_signature_sha256.clone(),
                        },
                    }
                }
            };
            Ok(projection)
        })();
        LockedSupervisorStatus {
            guard,
            outcome: Some(outcome),
        }
    }

    pub(crate) fn register(&self, command: RegisterCommand) -> LockedSupervisorCommit<'_> {
        let mut guard = self.store.lock_health();
        let outcome = (|| -> Result<SupervisorReceipt, CommitError> {
            let complete = self.store.begin(&mut guard, &command.head, false)?;
            if !matches!(
                complete.snapshot.state,
                VerifiedState::Empty
                    | VerifiedState::CandidateExpired { .. }
                    | VerifiedState::ApprovalExpired { .. }
            ) {
                return Err(CommitError::InvalidState);
            }
            let mut candidate = command.candidate;
            candidate.operation_authority_incarnation_sha256 = self.incarnation_sha256.clone();
            candidate.candidate_binding_sha256.clear();
            candidate.approval_challenge_sha256.clear();
            candidate.stored_at.clear();
            candidate.cutoff_at.clear();
            if candidate_identity_used(&complete.snapshot, &candidate)
                || authority_incarnation_used(&complete, &self.incarnation_sha256)
            {
                return Err(CommitError::Collision);
            }
            let trusted_at = self.clock.sample().map_err(|()| CommitError::Clock)?;
            require_monotonic_clock(&complete.snapshot, &trusted_at)?;
            seal_candidate(&mut candidate, &trusted_at).map_err(map_state_error)?;
            self.verify_signer_pin()?;
            let candidate_bytes = candidate.encode().map_err(|_| CommitError::Build)?;
            let candidate_sha256 = sha256_hex(&candidate_bytes);
            let next_generation = next_generation(&complete.snapshot)?;
            let transition_plan = plan_candidate_registered_transition(
                &candidate,
                candidate_sha256.clone(),
                next_generation,
                complete.snapshot.transition_sha256.clone(),
                complete.snapshot.state.name().to_owned(),
                trusted_at,
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            let expected_transition_bytes = transition_plan
                .expected_signed_bytes()
                .map_err(map_state_error)?;
            let artifact = ArtifactPublication::Candidate(ContentObject::leaf(candidate_bytes)?);
            let expected_candidate = candidate.clone();
            let expected_digest = candidate_sha256.clone();
            let (snapshot, proof) = self.store.publish_successor(
            &mut guard,
            complete,
            artifact,
            transition_plan,
            expected_transition_bytes,
            &self.signer,
            move |snapshot| {
                matches!(
                    &snapshot.state,
                    VerifiedState::CandidateRegistered {
                        candidate_sha256,
                        candidate,
                    } if candidate_sha256 == &expected_digest && candidate.as_ref() == &expected_candidate
                )
            },
        )?;
            Ok(SupervisorReceipt::Registered {
                proof,
                core: CommitCore {
                    generation: snapshot.generation,
                    transition_sha256: snapshot.transition_sha256,
                },
                candidate_sha256,
                candidate_binding_sha256: candidate.candidate_binding_sha256,
                approval_challenge_sha256: candidate.approval_challenge_sha256,
                cutoff_at: candidate.cutoff_at,
            })
        })();
        LockedSupervisorCommit {
            guard,
            family: SupervisorRequestFamily::RegisterCandidate,
            outcome: Some(outcome),
        }
    }

    pub(crate) fn approve(
        &self,
        command: ApproveCommand,
        verified: &RootVerifiedPreparedEnvelope,
        authentication: &FreshAttendedAuthentication,
    ) -> LockedOperatorCommit<'_> {
        let mut guard = self.store.lock_health();
        let outcome = (|| -> Result<OperatorReceipt, CommitError> {
            let complete = self.store.begin(&mut guard, &command.head, false)?;
            let (candidate_sha256, candidate) = match &complete.snapshot.state {
                VerifiedState::CandidateRegistered {
                    candidate_sha256,
                    candidate,
                } => (candidate_sha256.clone(), candidate.as_ref().clone()),
                _ => return Err(CommitError::InvalidState),
            };
            if (*guard == Health::Available
                && self.incarnation_sha256 != candidate.operation_authority_incarnation_sha256)
                || (*guard == Health::RecoveredNonterminal
                    && (self.incarnation_sha256
                        == candidate.operation_authority_incarnation_sha256
                        || authority_incarnation_used(&complete, &self.incarnation_sha256)))
            {
                return Err(CommitError::Policy);
            }
            if command.operation_id != candidate.operation_id
                || command.authorization_nonce != candidate.authorization_nonce
                || command.envelope_sha256 != candidate.envelope_sha256
                || command.action_challenge_sha256 != candidate.approval_challenge_sha256
                || authentication.action_challenge_sha256() != command.action_challenge_sha256
            {
                return Err(CommitError::Stale);
            }
            if !verified
                .matches_candidate(&candidate)
                .map_err(map_state_error)?
            {
                return Err(CommitError::Policy);
            }
            if authentication_session_used(&complete, authentication.session_sha256()) {
                return Err(CommitError::Collision);
            }
            let trusted_at = self.clock.sample().map_err(|()| CommitError::Clock)?;
            require_monotonic_clock(&complete.snapshot, &trusted_at)?;
            let approval_plan = plan_approval(
                &candidate,
                verified,
                authentication,
                &trusted_at,
                &self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            self.verify_signer_pin()?;
            let projected_grant = approval_plan.projected_signed();
            let projected_grant_bytes = projected_grant.encode().map_err(|_| CommitError::Build)?;
            let projected_transition = plan_approved_transition(
                &candidate,
                candidate_sha256.clone(),
                &projected_grant,
                "0".repeat(64),
                "0".repeat(64),
                next_generation(&complete.snapshot)?,
                complete.snapshot.transition_sha256.clone(),
                trusted_at.clone(),
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            let expected_transition_bytes = projected_transition
                .expected_signed_bytes()
                .map_err(map_state_error)?;
            validate_projection(
                &complete,
                &Footprint {
                    leaves: 1,
                    signatures: 2,
                    transitions: 1,
                    bytes: projected_grant_bytes
                        .len()
                        .checked_add(128)
                        .and_then(|value| value.checked_add(expected_transition_bytes))
                        .ok_or(CommitError::Capacity)?,
                },
            )?;
            let (grant, grant_signature) = approval_plan
                .sign(&self.signer, &self.store.pinned_public_key)
                .map_err(map_state_error)?;
            let grant_bytes = grant.encode().map_err(|_| CommitError::Build)?;
            if grant_bytes.len() != projected_grant_bytes.len() {
                return Err(CommitError::Build);
            }
            let signed_grant = SignedLeaf::new(grant_bytes, grant_signature)?;
            let grant_sha256 = signed_grant.leaf.digest.clone();
            let grant_signature_sha256 = signed_grant.signature_sha256.clone();
            let transition_plan = plan_approved_transition(
                &candidate,
                candidate_sha256,
                &grant,
                grant_sha256.clone(),
                grant_signature_sha256.clone(),
                next_generation(&complete.snapshot)?,
                complete.snapshot.transition_sha256.clone(),
                trusted_at,
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            if transition_plan
                .expected_signed_bytes()
                .map_err(map_state_error)?
                != expected_transition_bytes
            {
                return Err(CommitError::Build);
            }
            let expected_grant = grant.clone();
            let expected_grant_digest = grant_sha256.clone();
            let expected_signature_digest = grant_signature_sha256.clone();
            let (snapshot, proof) = self.store.publish_successor(
                &mut guard,
                complete,
                ArtifactPublication::Signed(signed_grant),
                transition_plan,
                expected_transition_bytes,
                &self.signer,
                move |snapshot| {
                    matches!(
                        &snapshot.state,
                        VerifiedState::Approved {
                            grant_sha256,
                            grant_signature_sha256,
                            grant,
                            ..
                        } if grant_sha256 == &expected_grant_digest
                            && grant_signature_sha256 == &expected_signature_digest
                            && grant.as_ref() == &expected_grant
                    )
                },
            )?;
            Ok(OperatorReceipt::Approved {
                proof,
                core: CommitCore {
                    generation: snapshot.generation,
                    transition_sha256: snapshot.transition_sha256,
                },
                grant_sha256,
                grant_signature_sha256,
                expires_at: grant.expires_at,
            })
        })();
        LockedOperatorCommit {
            guard,
            family: OperatorRequestFamily::ApproveCandidate,
            outcome: Some(outcome),
        }
    }

    pub(crate) fn consume(&self, command: ConsumeCommand) -> LockedSupervisorCommit<'_> {
        let mut guard = self.store.lock_health();
        let outcome = (|| -> Result<SupervisorReceipt, CommitError> {
            let complete = self.store.begin(&mut guard, &command.head, false)?;
            let (
                candidate_sha256,
                candidate,
                grant_sha256,
                grant_signature_sha256,
                grant,
                grant_signature,
            ) = match &complete.snapshot.state {
                VerifiedState::Approved {
                    candidate_sha256,
                    candidate,
                    grant_sha256,
                    grant_signature_sha256,
                    grant,
                    grant_signature,
                } => (
                    candidate_sha256.clone(),
                    candidate.as_ref().clone(),
                    grant_sha256.clone(),
                    grant_signature_sha256.clone(),
                    grant.as_ref().clone(),
                    *grant_signature,
                ),
                _ => return Err(CommitError::InvalidState),
            };
            if (*guard == Health::Available
                && self.incarnation_sha256 != candidate.operation_authority_incarnation_sha256)
                || (*guard == Health::RecoveredNonterminal
                    && (self.incarnation_sha256
                        == candidate.operation_authority_incarnation_sha256
                        || authority_incarnation_used(&complete, &self.incarnation_sha256)))
            {
                return Err(CommitError::Policy);
            }
            if command.operation_id != candidate.operation_id
                || command.authorization_nonce != candidate.authorization_nonce
                || command.grant_sha256 != grant_sha256
                || command.grant_signature_sha256 != grant_signature_sha256
            {
                return Err(CommitError::Stale);
            }
            let trusted_at = self.clock.sample().map_err(|()| CommitError::Clock)?;
            require_monotonic_clock(&complete.snapshot, &trusted_at)?;

            let projected_ticket = plan_ticket(
                &candidate,
                &grant,
                &grant_signature,
                &trusted_at,
                [0; 32],
                &self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            let projected_ticket_record = projected_ticket.projected_signed();
            let projected_ticket_bytes = projected_ticket_record
                .encode()
                .map_err(|_| CommitError::Build)?;
            let projected_transition = plan_consumed_transition(
                &candidate,
                candidate_sha256.clone(),
                &grant,
                grant_sha256.clone(),
                grant_signature_sha256.clone(),
                &projected_ticket_record,
                "0".repeat(64),
                "0".repeat(64),
                next_generation(&complete.snapshot)?,
                complete.snapshot.transition_sha256.clone(),
                trusted_at.clone(),
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            let expected_transition_bytes = projected_transition
                .expected_signed_bytes()
                .map_err(map_state_error)?;
            validate_projection(
                &complete,
                &Footprint {
                    leaves: 1,
                    signatures: 2,
                    transitions: 1,
                    bytes: projected_ticket_bytes
                        .len()
                        .checked_add(128)
                        .and_then(|value| value.checked_add(expected_transition_bytes))
                        .ok_or(CommitError::Capacity)?,
                },
            )?;

            let ticket_nonce = self
                .entropy
                .draw_once()
                .map_err(|()| CommitError::Entropy)?;
            if ticket_nonce_used(&complete.snapshot, &hex::encode(ticket_nonce)) {
                return Err(CommitError::Collision);
            }
            self.verify_signer_pin()?;
            let ticket_plan = plan_ticket(
                &candidate,
                &grant,
                &grant_signature,
                &trusted_at,
                ticket_nonce,
                &self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            let (ticket, ticket_signature) = ticket_plan
                .sign(&self.signer, &self.store.pinned_public_key)
                .map_err(map_state_error)?;
            let ticket_bytes = ticket.encode().map_err(|_| CommitError::Build)?;
            if ticket_bytes.len() != projected_ticket_bytes.len() {
                return Err(CommitError::Build);
            }
            let signed_ticket = SignedLeaf::new(ticket_bytes.clone(), ticket_signature)?;
            let ticket_sha256 = signed_ticket.leaf.digest.clone();
            let ticket_signature_sha256 = signed_ticket.signature_sha256.clone();
            let transition_plan = plan_consumed_transition(
                &candidate,
                candidate_sha256,
                &grant,
                grant_sha256,
                grant_signature_sha256,
                &ticket,
                ticket_sha256.clone(),
                ticket_signature_sha256.clone(),
                next_generation(&complete.snapshot)?,
                complete.snapshot.transition_sha256.clone(),
                trusted_at,
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            if transition_plan
                .expected_signed_bytes()
                .map_err(map_state_error)?
                != expected_transition_bytes
            {
                return Err(CommitError::Build);
            }
            let expected_ticket = ticket.clone();
            let expected_ticket_digest = ticket_sha256.clone();
            let expected_signature_digest = ticket_signature_sha256.clone();
            let (snapshot, proof) = self.store.publish_successor(
                &mut guard,
                complete,
                ArtifactPublication::Signed(signed_ticket),
                transition_plan,
                expected_transition_bytes,
                &self.signer,
                move |snapshot| {
                    matches!(
                        &snapshot.state,
                        VerifiedState::Consumed {
                            ticket_sha256,
                            ticket_signature_sha256,
                            ticket,
                            ..
                        } if ticket_sha256 == &expected_ticket_digest
                            && ticket_signature_sha256 == &expected_signature_digest
                            && ticket.as_ref() == &expected_ticket
                    )
                },
            )?;
            Ok(SupervisorReceipt::Consumed {
                proof,
                core: CommitCore {
                    generation: snapshot.generation,
                    transition_sha256: snapshot.transition_sha256,
                },
                ticket_bytes: ticket_bytes.into_boxed_slice(),
                ticket_signature,
            })
        })();
        LockedSupervisorCommit {
            guard,
            family: SupervisorRequestFamily::ConsumeGrant,
            outcome: Some(outcome),
        }
    }

    pub(crate) fn close_candidate(
        &self,
        command: CloseCandidateCommand,
        authentication: &FreshAttendedAuthentication,
    ) -> LockedOperatorCommit<'_> {
        let mut guard = self.store.lock_health();
        let outcome = (|| -> Result<OperatorReceipt, CommitError> {
            let complete = self.store.begin(&mut guard, &command.head, true)?;
            let (candidate_sha256, candidate) = match &complete.snapshot.state {
                VerifiedState::CandidateRegistered {
                    candidate_sha256,
                    candidate,
                } => (candidate_sha256.clone(), candidate.as_ref().clone()),
                _ => return Err(CommitError::InvalidState),
            };
            if (*guard == Health::Available
                && self.incarnation_sha256 != candidate.operation_authority_incarnation_sha256)
                || (*guard == Health::RecoveredNonterminal
                    && (self.incarnation_sha256
                        == candidate.operation_authority_incarnation_sha256
                        || authority_incarnation_used(&complete, &self.incarnation_sha256)))
            {
                return Err(CommitError::Policy);
            }
            if command.operation_id != candidate.operation_id
                || command.authorization_nonce != candidate.authorization_nonce
                || command.envelope_sha256 != candidate.envelope_sha256
                || command.action_challenge_sha256 != authentication.action_challenge_sha256()
            {
                return Err(CommitError::Stale);
            }
            if authentication_session_used(&complete, authentication.session_sha256()) {
                return Err(CommitError::Collision);
            }
            let trusted_at = self.clock.sample().map_err(|()| CommitError::Clock)?;
            require_monotonic_clock(&complete.snapshot, &trusted_at)?;
            let transition_plan = plan_close_candidate_transition(
                &candidate,
                candidate_sha256.clone(),
                next_generation(&complete.snapshot)?,
                complete.snapshot.transition_sha256.clone(),
                self.incarnation_sha256.clone(),
                command.action_challenge_sha256,
                authentication,
                trusted_at,
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            self.verify_signer_pin()?;
            let expected_transition_bytes = transition_plan
                .expected_signed_bytes()
                .map_err(map_state_error)?;
            let expected_candidate_digest = candidate_sha256;
            let (snapshot, proof) = self.store.publish_successor(
                &mut guard,
                complete,
                ArtifactPublication::None,
                transition_plan,
                expected_transition_bytes,
                &self.signer,
                move |snapshot| {
                    matches!(
                        &snapshot.state,
                        VerifiedState::CandidateExpired { candidate_sha256, .. }
                            if candidate_sha256 == &expected_candidate_digest
                    )
                },
            )?;
            Ok(OperatorReceipt::CandidateExpired {
                proof,
                core: CommitCore {
                    generation: snapshot.generation,
                    transition_sha256: snapshot.transition_sha256,
                },
            })
        })();
        LockedOperatorCommit {
            guard,
            family: OperatorRequestFamily::CloseExpiredCandidate,
            outcome: Some(outcome),
        }
    }

    pub(crate) fn close_approval(
        &self,
        command: CloseApprovalCommand,
        authentication: &FreshAttendedAuthentication,
    ) -> LockedOperatorCommit<'_> {
        let mut guard = self.store.lock_health();
        let outcome = (|| -> Result<OperatorReceipt, CommitError> {
            let complete = self.store.begin(&mut guard, &command.head, true)?;
            let (
                candidate_sha256,
                candidate,
                grant_sha256,
                grant_signature_sha256,
                grant,
                grant_signature,
            ) = match &complete.snapshot.state {
                VerifiedState::Approved {
                    candidate_sha256,
                    candidate,
                    grant_sha256,
                    grant_signature_sha256,
                    grant,
                    grant_signature,
                } => (
                    candidate_sha256.clone(),
                    candidate.as_ref().clone(),
                    grant_sha256.clone(),
                    grant_signature_sha256.clone(),
                    grant.as_ref().clone(),
                    *grant_signature,
                ),
                _ => return Err(CommitError::InvalidState),
            };
            if (*guard == Health::Available
                && self.incarnation_sha256 != candidate.operation_authority_incarnation_sha256)
                || (*guard == Health::RecoveredNonterminal
                    && (self.incarnation_sha256
                        == candidate.operation_authority_incarnation_sha256
                        || authority_incarnation_used(&complete, &self.incarnation_sha256)))
            {
                return Err(CommitError::Policy);
            }
            if command.operation_id != candidate.operation_id
                || command.authorization_nonce != candidate.authorization_nonce
                || command.envelope_sha256 != candidate.envelope_sha256
                || command.grant_sha256 != grant_sha256
                || command.grant_signature_sha256 != grant_signature_sha256
                || command.action_challenge_sha256 != authentication.action_challenge_sha256()
            {
                return Err(CommitError::Stale);
            }
            if authentication_session_used(&complete, authentication.session_sha256()) {
                return Err(CommitError::Collision);
            }
            let trusted_at = self.clock.sample().map_err(|()| CommitError::Clock)?;
            require_monotonic_clock(&complete.snapshot, &trusted_at)?;
            let transition_plan = plan_close_approval_transition(
                &candidate,
                candidate_sha256,
                &grant,
                &grant_signature,
                grant_sha256.clone(),
                grant_signature_sha256.clone(),
                next_generation(&complete.snapshot)?,
                complete.snapshot.transition_sha256.clone(),
                self.incarnation_sha256.clone(),
                command.action_challenge_sha256,
                authentication,
                trusted_at,
                self.store.pinned_public_key,
            )
            .map_err(map_state_error)?;
            self.verify_signer_pin()?;
            let expected_transition_bytes = transition_plan
                .expected_signed_bytes()
                .map_err(map_state_error)?;
            let expected_grant_digest = grant_sha256;
            let expected_signature_digest = grant_signature_sha256;
            let (snapshot, proof) = self.store.publish_successor(
                &mut guard,
                complete,
                ArtifactPublication::None,
                transition_plan,
                expected_transition_bytes,
                &self.signer,
                move |snapshot| {
                    matches!(
                        &snapshot.state,
                        VerifiedState::ApprovalExpired {
                            grant_sha256,
                            grant_signature_sha256,
                            ..
                        } if grant_sha256 == &expected_grant_digest
                            && grant_signature_sha256 == &expected_signature_digest
                    )
                },
            )?;
            Ok(OperatorReceipt::ApprovalExpired {
                proof,
                core: CommitCore {
                    generation: snapshot.generation,
                    transition_sha256: snapshot.transition_sha256,
                },
            })
        })();
        LockedOperatorCommit {
            guard,
            family: OperatorRequestFamily::CloseExpiredApproval,
            outcome: Some(outcome),
        }
    }

    fn verify_signer_pin(&self) -> Result<(), CommitError> {
        if self.signer.public_key_bytes() == self.store.pinned_public_key {
            Ok(())
        } else {
            Err(CommitError::Signer)
        }
    }
}

fn next_generation(snapshot: &VerifiedSnapshot) -> Result<u64, CommitError> {
    snapshot
        .generation
        .checked_add(1)
        .filter(|generation| *generation <= MAX_TRANSITIONS as u64)
        .ok_or(CommitError::Capacity)
}

fn require_monotonic_clock(
    snapshot: &VerifiedSnapshot,
    trusted_at: &str,
) -> Result<(), CommitError> {
    let sampled = validate_whole_timestamp(trusted_at).map_err(|_| CommitError::Clock)?;
    if let Some(prior) = &snapshot.trusted_at {
        let prior = validate_whole_timestamp(prior).map_err(|_| CommitError::Unavailable)?;
        if sampled < prior {
            return Err(CommitError::Clock);
        }
    }
    Ok(())
}

fn candidate_identity_used(snapshot: &VerifiedSnapshot, candidate: &Candidate) -> bool {
    snapshot.operations.values().any(|operation| {
        let existing = match &operation.state {
            VerifiedState::Empty => return false,
            VerifiedState::CandidateRegistered { candidate, .. }
            | VerifiedState::Approved { candidate, .. }
            | VerifiedState::Consumed { candidate, .. }
            | VerifiedState::CandidateExpired { candidate, .. }
            | VerifiedState::ApprovalExpired { candidate, .. } => candidate,
        };
        existing.operation_id == candidate.operation_id
            || existing.authorization_nonce == candidate.authorization_nonce
            || existing.envelope_sha256 == candidate.envelope_sha256
    })
}

fn authority_incarnation_used(complete: &CompleteInventory, incarnation: &str) -> bool {
    complete.inventory.transitions.values().any(|file| {
        Transition::decode(&file.bytes).is_ok_and(|transition| match transition {
            Transition::CandidateRegistered(record) => {
                record.operation_authority_incarnation_sha256 == incarnation
            }
            Transition::Approved(record) => {
                record.operation_authority_incarnation_sha256 == incarnation
            }
            Transition::Consumed(record) => {
                record.operation_authority_incarnation_sha256 == incarnation
            }
            Transition::CandidateExpired(record) => {
                record.operation_authority_incarnation_sha256 == incarnation
                    || record.closing_authority_incarnation_sha256 == incarnation
            }
            Transition::ApprovalExpired(record) => {
                record.operation_authority_incarnation_sha256 == incarnation
                    || record.closing_authority_incarnation_sha256 == incarnation
            }
        })
    })
}

fn authentication_session_used(complete: &CompleteInventory, session: &str) -> bool {
    let grant_used =
        complete
            .snapshot
            .operations
            .values()
            .any(|operation| match &operation.state {
                VerifiedState::Approved { grant, .. }
                | VerifiedState::Consumed { grant, .. }
                | VerifiedState::ApprovalExpired { grant, .. } => {
                    grant.os_authentication_session_sha256 == session
                }
                VerifiedState::Empty
                | VerifiedState::CandidateRegistered { .. }
                | VerifiedState::CandidateExpired { .. } => false,
            });
    grant_used
        || complete.inventory.transitions.values().any(|file| {
            Transition::decode(&file.bytes).is_ok_and(|transition| match transition {
                Transition::CandidateExpired(record) => {
                    record.os_authentication_session_sha256 == session
                }
                Transition::ApprovalExpired(record) => {
                    record.os_authentication_session_sha256 == session
                }
                Transition::CandidateRegistered(_)
                | Transition::Approved(_)
                | Transition::Consumed(_) => false,
            })
        })
}

fn ticket_nonce_used(snapshot: &VerifiedSnapshot, nonce: &str) -> bool {
    snapshot.operations.values().any(|operation| {
        matches!(
            &operation.state,
            VerifiedState::Consumed { ticket, .. } if ticket.ticket_nonce == nonce
        )
    })
}

fn validate_projection(
    complete: &CompleteInventory,
    footprint: &Footprint,
) -> Result<(), CommitError> {
    if footprint.bytes < 64 || footprint.bytes > MAX_TOTAL_BYTES {
        return Err(CommitError::Capacity);
    }
    let projected_leaves = complete
        .inventory
        .leaves
        .len()
        .checked_add(footprint.leaves)
        .ok_or(CommitError::Capacity)?;
    let projected_signatures = complete
        .inventory
        .signatures
        .len()
        .checked_add(footprint.signatures)
        .ok_or(CommitError::Capacity)?;
    let projected_transitions = complete
        .inventory
        .transitions
        .len()
        .checked_add(footprint.transitions)
        .ok_or(CommitError::Capacity)?;
    let projected_total = complete
        .total_bytes
        .checked_add(footprint.bytes)
        .ok_or(CommitError::Capacity)?;
    if projected_leaves > MAX_LEAVES
        || projected_signatures > MAX_SIGNATURES
        || projected_transitions > MAX_TRANSITIONS
        || projected_total > MAX_TOTAL_BYTES
    {
        return Err(CommitError::Capacity);
    }
    Ok(())
}

fn validate_artifact_names(
    complete: &CompleteInventory,
    artifact: &ArtifactPublication,
) -> Result<(), CommitError> {
    match artifact {
        ArtifactPublication::None => Ok(()),
        ArtifactPublication::Candidate(leaf) => {
            if complete.inventory.leaves.contains_key(&leaf.digest) {
                Err(CommitError::Collision)
            } else {
                Ok(())
            }
        }
        ArtifactPublication::Signed(signed) => {
            if complete.inventory.leaves.contains_key(&signed.leaf.digest)
                || complete
                    .inventory
                    .signatures
                    .contains_key(&signed.signature_sha256)
            {
                Err(CommitError::Collision)
            } else {
                Ok(())
            }
        }
    }
}

fn prepare_transition(
    transition_plan: TransitionPlan,
    expected_transition_bytes: usize,
    signer: &impl RecordSigner,
    pinned_public_key: &[u8; 32],
    complete: &CompleteInventory,
    artifact: &ArtifactPublication,
) -> Result<PreparedTransition, CommitError> {
    let (transition, signature) = transition_plan
        .sign(
            super::PostArtifactPublication::completed(),
            signer,
            pinned_public_key,
        )
        .map_err(map_state_error)?;
    let bytes = transition.encode().map_err(|_| CommitError::Build)?;
    if bytes.len() != expected_transition_bytes
        || verify_transition(&transition, &signature, pinned_public_key).is_err()
    {
        return Err(CommitError::Build);
    }
    let signature_sha256 = sha256_hex(&signature);
    if complete
        .inventory
        .signatures
        .contains_key(&signature_sha256)
        || match artifact {
            ArtifactPublication::Signed(signed) => signed.signature_sha256 == signature_sha256,
            ArtifactPublication::None | ArtifactPublication::Candidate(_) => false,
        }
    {
        return Err(CommitError::Collision);
    }
    let generation = transition.generation();
    if complete.inventory.transitions.contains_key(&generation) {
        return Err(CommitError::Collision);
    }
    let sha256 = sha256_hex(&bytes);
    let name = format!("{generation:020}-{sha256}.json");
    Ok(PreparedTransition {
        signature,
        signature_sha256,
        bytes,
        sha256,
        name,
    })
}

fn map_state_error(error: StateError) -> CommitError {
    match error {
        StateError::Canonical => CommitError::Build,
        StateError::Crypto => CommitError::Signer,
        StateError::Expired => CommitError::Expired,
        StateError::Future | StateError::Stale => CommitError::Clock,
        StateError::NotExpired => CommitError::NotExpired,
        StateError::PolicyMismatch => CommitError::Policy,
    }
}

fn refusal_code(error: CommitError) -> RefusalCode {
    match error {
        CommitError::Build => RefusalCode::InvalidRequest,
        CommitError::Capacity | CommitError::Sealed | CommitError::Unavailable => {
            RefusalCode::JournalUnavailable
        }
        CommitError::Clock => RefusalCode::ClockInvalid,
        CommitError::Collision => RefusalCode::NonceCollision,
        CommitError::Entropy => RefusalCode::EntropyUnavailable,
        CommitError::Expired => RefusalCode::Expired,
        CommitError::InvalidState => RefusalCode::InvalidState,
        CommitError::NotExpired => RefusalCode::NotExpired,
        CommitError::Policy => RefusalCode::PolicyMismatch,
        CommitError::RecoveryOnly => RefusalCode::RecoveryOnly,
        CommitError::Signer => RefusalCode::SignerUnavailable,
        CommitError::Stale => RefusalCode::StaleCompareAndSet,
    }
}

fn verify_local_filesystem(fd: &OwnedFd) -> Result<(), ()> {
    let magic = fstatfs(fd).map_err(|_| ())?.f_type as u64;
    let synthetic_tmpfs = cfg!(test) && magic == TMPFS_MAGIC;
    if ![EXT_FAMILY_MAGIC, XFS_MAGIC].contains(&magic) && !synthetic_tmpfs {
        return Err(());
    }
    Ok(())
}

fn open_directory(parent: &OwnedFd, name: &CStr, owner: Owner, nlink: u64) -> Result<OwnedFd, ()> {
    let fd = openat2(parent, name, DIRECTORY_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
    verify_entry_matches_fd(parent, name, &fd, owner, FileType::Directory, 0o700, nlink)?;
    Ok(fd)
}

fn open_regular(
    parent: &OwnedFd,
    name: &CStr,
    owner: Owner,
    size: usize,
    writable: bool,
) -> Result<OwnedFd, ()> {
    let flags = if writable {
        OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW
    } else {
        READ_FLAGS
    };
    let fd = openat2(parent, name, flags, Mode::empty(), RESOLVE).map_err(|_| ())?;
    verify_entry_matches_fd(parent, name, &fd, owner, FileType::RegularFile, 0o600, 1)?;
    if fstat(&fd).map_err(|_| ())?.st_size != size as i64 {
        return Err(());
    }
    Ok(fd)
}

fn verify_entry_matches_fd(
    parent: &OwnedFd,
    name: &CStr,
    fd: &OwnedFd,
    owner: Owner,
    file_type: FileType,
    mode: u32,
    nlink: u64,
) -> Result<Stat, ()> {
    let entry = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| ())?;
    let opened = fstat(fd).map_err(|_| ())?;
    if entry.st_dev != opened.st_dev
        || entry.st_ino != opened.st_ino
        || entry.st_mode != opened.st_mode
        || entry.st_uid != opened.st_uid
        || entry.st_gid != opened.st_gid
        || entry.st_nlink != opened.st_nlink
        || entry.st_size != opened.st_size
    {
        return Err(());
    }
    verify_metadata(&opened, owner, file_type, mode, nlink)?;
    Ok(opened)
}

fn verify_directory(stat: &Stat, owner: Owner, mode: u32, nlink: u64) -> Result<(), ()> {
    verify_metadata(stat, owner, FileType::Directory, mode, nlink)
}

fn verify_metadata(
    stat: &Stat,
    owner: Owner,
    expected_type: FileType,
    expected_mode: u32,
    expected_nlink: u64,
) -> Result<(), ()> {
    if FileType::from_raw_mode(stat.st_mode) != expected_type
        || Mode::from_raw_mode(stat.st_mode).as_raw_mode() != expected_mode
        || stat.st_uid != owner.uid
        || stat.st_gid != owner.gid
        || stat.st_dev != owner.dev
        || stat.st_nlink != expected_nlink
        || stat.st_size < 0
    {
        return Err(());
    }
    Ok(())
}

fn require_names(directory: &OwnedFd, expected: &[&str]) -> Result<(), ()> {
    let actual: BTreeSet<String> = read_names(directory, expected.len())?.into_iter().collect();
    let expected: BTreeSet<String> = expected.iter().map(|name| (*name).to_owned()).collect();
    if actual != expected {
        return Err(());
    }
    Ok(())
}

fn read_names(directory: &OwnedFd, limit: usize) -> Result<Vec<String>, ()> {
    rustix::fs::seek(directory, rustix::fs::SeekFrom::Start(0)).map_err(|_| ())?;
    let mut buffer = [MaybeUninit::<u8>::uninit(); 8192];
    let mut reader = RawDir::new(directory, &mut buffer);
    let mut names = Vec::new();
    while let Some(entry) = reader.next() {
        let entry = entry.map_err(|_| ())?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        if names.len() == limit {
            return Err(());
        }
        names.push(std::str::from_utf8(bytes).map_err(|_| ())?.to_owned());
    }
    Ok(names)
}

#[allow(clippy::too_many_arguments)]
fn scan_objects(
    directory: &OwnedFd,
    owner: Owner,
    limit: usize,
    signatures: bool,
    namespace: &str,
    total: &mut usize,
    identities: &mut BTreeMap<String, FileIdentity>,
    inventory_digest: &mut Sha256,
) -> Result<BTreeMap<String, Vec<u8>>, ()> {
    let mut names = read_names(directory, limit)?;
    names.sort_unstable();
    let mut objects = BTreeMap::new();
    for name in names {
        if !is_digest(&name) {
            return Err(());
        }
        let c_name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
        let fd = openat2(directory, &c_name, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
        let stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        let size = usize::try_from(stat.st_size).map_err(|_| ())?;
        if (signatures && size != 64) || (!signatures && (size == 0 || size > MAX_CANONICAL_BYTES))
        {
            return Err(());
        }
        *total = total.checked_add(size).ok_or(())?;
        if *total > MAX_TOTAL_BYTES {
            return Err(());
        }
        let bytes = read_exact_file(&fd, size)?;
        let final_stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if !same_stat(&stat, &final_stat) {
            return Err(());
        }
        if identities
            .insert(
                format!("{namespace}/{name}"),
                FileIdentity::from(&final_stat),
            )
            .is_some()
        {
            return Err(());
        }
        update_inventory_digest(inventory_digest, namespace, &name, &bytes)?;
        if name != crate::crypto::sha256_hex(&bytes) || objects.insert(name, bytes).is_some() {
            return Err(());
        }
    }
    Ok(objects)
}

fn scan_transitions(
    directory: &OwnedFd,
    owner: Owner,
    total: &mut usize,
    identities: &mut BTreeMap<String, FileIdentity>,
    inventory_digest: &mut Sha256,
) -> Result<BTreeMap<u64, TransitionFile>, ()> {
    let mut names = read_names(directory, MAX_TRANSITIONS)?;
    names.sort_unstable();
    let mut transitions = BTreeMap::new();
    for name in names {
        let (generation, digest) = parse_transition_name(&name)?;
        let c_name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
        let fd = openat2(directory, &c_name, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
        let stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        let size = usize::try_from(stat.st_size).map_err(|_| ())?;
        if size == 0 || size > MAX_CANONICAL_BYTES {
            return Err(());
        }
        *total = total.checked_add(size).ok_or(())?;
        if *total > MAX_TOTAL_BYTES {
            return Err(());
        }
        let bytes = read_exact_file(&fd, size)?;
        let final_stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if !same_stat(&stat, &final_stat) {
            return Err(());
        }
        if identities
            .insert(
                format!("transitions/{name}"),
                FileIdentity::from(&final_stat),
            )
            .is_some()
        {
            return Err(());
        }
        update_inventory_digest(inventory_digest, "transitions", &name, &bytes)?;
        if digest != crate::crypto::sha256_hex(&bytes)
            || transitions
                .insert(generation, TransitionFile { digest, bytes })
                .is_some()
        {
            return Err(());
        }
    }
    Ok(transitions)
}

#[allow(clippy::too_many_arguments)]
fn scan_objects_revalidation(
    directory: &OwnedFd,
    owner: Owner,
    limit: usize,
    signatures: bool,
    namespace: &str,
    total: &mut usize,
    identities: &mut BTreeMap<String, FileIdentity>,
    inventory_digest: &mut Sha256,
) -> Result<(), ()> {
    let mut names = read_names(directory, limit)?;
    names.sort_unstable();
    for name in names {
        if !is_digest(&name) {
            return Err(());
        }
        let c_name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
        let fd = openat2(directory, &c_name, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
        let stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        let size = usize::try_from(stat.st_size).map_err(|_| ())?;
        if (signatures && size != 64) || (!signatures && (size == 0 || size > MAX_CANONICAL_BYTES))
        {
            return Err(());
        }
        add_inventory_bytes(total, size)?;
        let content_digest = digest_exact_file(inventory_digest, namespace, &name, &fd, size)?;
        let final_stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if !same_stat(&stat, &final_stat)
            || identities
                .insert(
                    format!("{namespace}/{name}"),
                    FileIdentity::from(&final_stat),
                )
                .is_some()
            || name != hex::encode(content_digest)
        {
            return Err(());
        }
    }
    Ok(())
}

fn scan_transitions_revalidation(
    directory: &OwnedFd,
    owner: Owner,
    total: &mut usize,
    identities: &mut BTreeMap<String, FileIdentity>,
    inventory_digest: &mut Sha256,
) -> Result<(), ()> {
    let mut names = read_names(directory, MAX_TRANSITIONS)?;
    names.sort_unstable();
    let mut generations = BTreeSet::new();
    for name in names {
        let (generation, expected_digest) = parse_transition_name(&name)?;
        if !generations.insert(generation) {
            return Err(());
        }
        let c_name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
        let fd = openat2(directory, &c_name, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
        let stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        let size = usize::try_from(stat.st_size).map_err(|_| ())?;
        if size == 0 || size > MAX_CANONICAL_BYTES {
            return Err(());
        }
        add_inventory_bytes(total, size)?;
        let content_digest = digest_exact_file(inventory_digest, "transitions", &name, &fd, size)?;
        let final_stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if !same_stat(&stat, &final_stat)
            || identities
                .insert(
                    format!("transitions/{name}"),
                    FileIdentity::from(&final_stat),
                )
                .is_some()
            || expected_digest != hex::encode(content_digest)
        {
            return Err(());
        }
    }
    Ok(())
}

fn inventory_digest() -> Sha256 {
    let mut digest = Sha256::new();
    digest.update(INVENTORY_DIGEST_DOMAIN);
    digest
}

fn update_inventory_digest(
    digest: &mut Sha256,
    namespace: &str,
    name: &str,
    bytes: &[u8],
) -> Result<(), ()> {
    update_inventory_digest_header(digest, namespace, name, bytes.len())?;
    digest.update(bytes);
    Ok(())
}

fn update_inventory_digest_header(
    digest: &mut Sha256,
    namespace: &str,
    name: &str,
    size: usize,
) -> Result<(), ()> {
    digest.update(
        u64::try_from(namespace.len())
            .map_err(|_| ())?
            .to_be_bytes(),
    );
    digest.update(namespace.as_bytes());
    digest.update(u64::try_from(name.len()).map_err(|_| ())?.to_be_bytes());
    digest.update(name.as_bytes());
    digest.update(u64::try_from(size).map_err(|_| ())?.to_be_bytes());
    Ok(())
}

fn add_inventory_bytes(total: &mut usize, size: usize) -> Result<(), ()> {
    *total = total.checked_add(size).ok_or(())?;
    if *total > MAX_TOTAL_BYTES {
        return Err(());
    }
    Ok(())
}

fn digest_exact_file(
    inventory_digest: &mut Sha256,
    namespace: &str,
    name: &str,
    fd: &OwnedFd,
    size: usize,
) -> Result<[u8; 32], ()> {
    update_inventory_digest_header(inventory_digest, namespace, name, size)?;
    rustix::fs::seek(fd, rustix::fs::SeekFrom::Start(0)).map_err(|_| ())?;
    let mut content_digest = Sha256::new();
    let mut buffer = [0_u8; 8192];
    let mut remaining = size;
    while remaining != 0 {
        let requested = remaining.min(buffer.len());
        match read(fd, &mut buffer[..requested]) {
            Ok(0) => return Err(()),
            Ok(read_count) => {
                content_digest.update(&buffer[..read_count]);
                inventory_digest.update(&buffer[..read_count]);
                remaining -= read_count;
            }
            Err(Errno::INTR) => {}
            Err(_) => return Err(()),
        }
    }
    loop {
        match read(fd, &mut buffer[..1]) {
            Ok(0) => break,
            Ok(_) => return Err(()),
            Err(Errno::INTR) => {}
            Err(_) => return Err(()),
        }
    }
    Ok(content_digest.finalize().into())
}

fn parse_transition_name(name: &str) -> Result<(u64, String), ()> {
    if name.len() != 20 + 1 + 64 + 5
        || name.as_bytes().get(20) != Some(&b'-')
        || !name.ends_with(".json")
        || !name.as_bytes()[..20].iter().all(u8::is_ascii_digit)
    {
        return Err(());
    }
    let digest = &name[21..85];
    if !is_digest(digest) {
        return Err(());
    }
    let generation = name[..20].parse::<u64>().map_err(|_| ())?;
    if generation == 0 || generation > 9_999_999_999 {
        return Err(());
    }
    Ok((generation, digest.to_owned()))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_exact_file(fd: &OwnedFd, size: usize) -> Result<Vec<u8>, ()> {
    rustix::fs::seek(fd, rustix::fs::SeekFrom::Start(0)).map_err(|_| ())?;
    let mut bytes = vec![0; size];
    let mut offset = 0;
    while offset < size {
        match read(fd, &mut bytes[offset..]) {
            Ok(0) => return Err(()),
            Ok(read_count) => offset += read_count,
            Err(Errno::INTR) => {}
            Err(_) => return Err(()),
        }
    }
    let mut extra = [0_u8; 1];
    match read(fd, &mut extra) {
        Ok(0) => {}
        Ok(_) => return Err(()),
        Err(Errno::INTR) => return Err(()),
        Err(_) => return Err(()),
    }
    Ok(bytes)
}

fn acquire_ofd_lock(fd: &OwnedFd) -> Result<(), ()> {
    let lock = nix::libc::flock {
        l_type: nix::libc::F_WRLCK as nix::libc::c_short,
        l_whence: nix::libc::SEEK_SET as nix::libc::c_short,
        l_start: 0,
        l_len: 0,
        l_pid: 0,
    };
    fcntl(fd, FcntlArg::F_OFD_SETLK(&lock)).map_err(|_| ())?;
    Ok(())
}

fn publish(directory: &OwnedFd, name: &str, bytes: &[u8], owner: Owner) -> Result<(), ()> {
    #[cfg(test)]
    let publication_ordinal = test_fault::next_publication();
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
    let fd = openat2(
        directory,
        &name,
        CREATE_FLAGS,
        Mode::RUSR | Mode::WUSR,
        RESOLVE,
    )
    .map_err(|_| ())?;
    #[cfg(test)]
    test_fault::check_publication(
        publication_ordinal,
        TestPublicationBoundary::FinalNameCreated,
    )?;
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(test)]
        let remaining = if offset == 0 && test_fault::armed() && bytes.len() > 7 {
            &bytes[offset..7]
        } else {
            &bytes[offset..]
        };
        #[cfg(not(test))]
        let remaining = &bytes[offset..];
        match write(&fd, remaining) {
            Ok(0) => return Err(()),
            Ok(written) => {
                offset += written;
                #[cfg(test)]
                if offset < bytes.len() {
                    test_fault::check_publication(
                        publication_ordinal,
                        TestPublicationBoundary::PartialWrite,
                    )?;
                }
            }
            Err(Errno::INTR) => {}
            Err(_) => return Err(()),
        }
    }
    #[cfg(test)]
    test_fault::check_publication(publication_ordinal, TestPublicationBoundary::CompleteWrite)?;
    let published = verify_entry_matches_fd(
        directory,
        &name,
        &fd,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if published.st_size != bytes.len() as i64 {
        return Err(());
    }
    #[cfg(test)]
    test_fault::check_publication(
        publication_ordinal,
        TestPublicationBoundary::MetadataVerified,
    )?;
    fsync(&fd).map_err(|_| ())?;
    #[cfg(test)]
    test_fault::check_publication(publication_ordinal, TestPublicationBoundary::FileSynced)?;
    fsync(directory).map_err(|_| ())?;
    #[cfg(test)]
    test_fault::check_publication(
        publication_ordinal,
        TestPublicationBoundary::DirectorySynced,
    )?;
    Ok(())
}

fn same_stat(left: &Stat, right: &Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode == right.st_mode
        && left.st_nlink == right.st_nlink
        && left.st_uid == right.st_uid
        && left.st_gid == right.st_gid
        && left.st_size == right.st_size
        && left.st_mtime == right.st_mtime
        && left.st_mtime_nsec == right.st_mtime_nsec
        && left.st_ctime == right.st_ctime
        && left.st_ctime_nsec == right.st_ctime_nsec
}
