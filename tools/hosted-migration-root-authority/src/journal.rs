//! Immutable journal inventory, reduction and direct-final publication.

use std::collections::{BTreeMap, BTreeSet};

use crate::canonical::{
    CanonicalError, MAX_CANONICAL_BYTES, add_whole_seconds, select_minimum,
    validate_millisecond_timestamp, validate_whole_timestamp,
};
use crate::crypto::{CryptoError, sha256_hex, verify_grant, verify_ticket, verify_transition};
use crate::records::{ApprovalGrant, Candidate, ExecutionTicket, GENESIS_SHA256, Transition};
use crate::state::{
    StateError, derive_approval_close_challenge, derive_candidate_close_challenge,
    grant_matches_candidate, seal_candidate, ticket_matches_grant,
};

pub(crate) mod storage;

pub(crate) const FORMAT_BYTES: &[u8] = b"openspell.hosted-migration-root-journal.v1\n";
pub(crate) const MAX_TRANSITIONS: usize = 4_096;
pub(crate) const MAX_LEAVES: usize = 12_288;
pub(crate) const MAX_SIGNATURES: usize = 16_384;
pub(crate) const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JournalError {
    Canonical,
    Crypto,
    Limit,
    Shape,
    State,
    Unreferenced,
}

impl From<CanonicalError> for JournalError {
    fn from(_: CanonicalError) -> Self {
        Self::Canonical
    }
}

impl From<CryptoError> for JournalError {
    fn from(_: CryptoError) -> Self {
        Self::Crypto
    }
}

impl From<StateError> for JournalError {
    fn from(_: StateError) -> Self {
        Self::State
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InventoryFiles {
    pub(crate) leaves: BTreeMap<String, Vec<u8>>,
    pub(crate) signatures: BTreeMap<String, Vec<u8>>,
    pub(crate) transitions: BTreeMap<u64, TransitionFile>,
}

impl InventoryFiles {
    #[cfg(test)]
    pub(crate) fn empty() -> Self {
        Self {
            leaves: BTreeMap::new(),
            signatures: BTreeMap::new(),
            transitions: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TransitionFile {
    pub(crate) digest: String,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum VerifiedState {
    Empty,
    CandidateRegistered {
        candidate_sha256: String,
        candidate: Box<Candidate>,
    },
    Approved {
        candidate_sha256: String,
        candidate: Box<Candidate>,
        grant_sha256: String,
        grant_signature_sha256: String,
        grant: Box<ApprovalGrant>,
        grant_signature: [u8; 64],
    },
    Consumed {
        candidate_sha256: String,
        candidate: Box<Candidate>,
        grant_sha256: String,
        grant_signature_sha256: String,
        grant: Box<ApprovalGrant>,
        ticket_sha256: String,
        ticket_signature_sha256: String,
        ticket: Box<ExecutionTicket>,
    },
    CandidateExpired {
        candidate_sha256: String,
        candidate: Box<Candidate>,
    },
    ApprovalExpired {
        candidate_sha256: String,
        candidate: Box<Candidate>,
        grant_sha256: String,
        grant_signature_sha256: String,
        grant: Box<ApprovalGrant>,
    },
}

impl VerifiedState {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::CandidateRegistered { .. } => "candidate_registered",
            Self::Approved { .. } => "approved",
            Self::Consumed { .. } => "consumed",
            Self::CandidateExpired { .. } => "candidate_expired",
            Self::ApprovalExpired { .. } => "approval_expired",
        }
    }

    pub(crate) fn is_nonterminal(&self) -> bool {
        matches!(
            self,
            Self::CandidateRegistered { .. } | Self::Approved { .. }
        )
    }

    pub(crate) fn operation_id(&self) -> Option<&str> {
        match self {
            Self::Empty => None,
            Self::CandidateRegistered { candidate, .. }
            | Self::Approved { candidate, .. }
            | Self::Consumed { candidate, .. }
            | Self::CandidateExpired { candidate, .. }
            | Self::ApprovalExpired { candidate, .. } => Some(&candidate.operation_id),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OperationSummary {
    pub(crate) generation: u64,
    pub(crate) transition_sha256: String,
    pub(crate) state: VerifiedState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedSnapshot {
    pub(crate) generation: u64,
    pub(crate) transition_sha256: String,
    pub(crate) trusted_at: Option<String>,
    pub(crate) state: VerifiedState,
    pub(crate) operations: BTreeMap<String, OperationSummary>,
}

#[derive(Default)]
struct UniqueFacts {
    operation_ids: BTreeSet<String>,
    authorization_nonces: BTreeSet<String>,
    envelope_digests: BTreeSet<String>,
    authentication_sessions: BTreeSet<String>,
    authority_incarnations: BTreeSet<String>,
    ticket_nonces: BTreeSet<String>,
}

pub(crate) fn verify_inventory(
    inventory: &InventoryFiles,
    pinned_public_key: &[u8; 32],
) -> Result<VerifiedSnapshot, JournalError> {
    verify_inventory_limits(inventory)?;
    verify_content_addresses(&inventory.leaves, false)?;
    verify_content_addresses(&inventory.signatures, true)?;

    let mut referenced_leaves = BTreeSet::new();
    let mut referenced_signatures = BTreeSet::new();
    let mut facts = UniqueFacts::default();
    let mut snapshot = VerifiedSnapshot {
        generation: 0,
        transition_sha256: GENESIS_SHA256.to_owned(),
        trusted_at: None,
        state: VerifiedState::Empty,
        operations: BTreeMap::new(),
    };

    for (&generation, file) in &inventory.transitions {
        if generation != snapshot.generation + 1
            || file.digest != sha256_hex(&file.bytes)
            || file.bytes.len() > MAX_CANONICAL_BYTES
        {
            return Err(JournalError::Shape);
        }
        let transition = Transition::decode(&file.bytes)?;
        if transition.generation() != generation
            || transition.previous_transition_sha256() != snapshot.transition_sha256
        {
            return Err(JournalError::State);
        }
        let transition_time = validate_whole_timestamp(transition.trusted_at())?;
        if let Some(prior) = &snapshot.trusted_at
            && transition_time < validate_whole_timestamp(prior)?
        {
            return Err(JournalError::State);
        }
        let transition_signature = load_signature(
            &inventory.signatures,
            transition.detached_signature_sha256(),
            &mut referenced_signatures,
        )?;
        verify_transition(&transition, &transition_signature, pinned_public_key)?;
        let next_state = reduce_transition(
            &snapshot,
            &transition,
            inventory,
            pinned_public_key,
            &mut referenced_leaves,
            &mut referenced_signatures,
            &mut facts,
        )?;
        if let Some(operation_id) = next_state.operation_id() {
            snapshot.operations.insert(
                operation_id.to_owned(),
                OperationSummary {
                    generation,
                    transition_sha256: file.digest.clone(),
                    state: next_state.clone(),
                },
            );
        }
        snapshot.generation = generation;
        snapshot.transition_sha256 = file.digest.clone();
        snapshot.trusted_at = Some(transition.trusted_at().to_owned());
        snapshot.state = next_state;
    }

    if referenced_leaves != inventory.leaves.keys().cloned().collect()
        || referenced_signatures != inventory.signatures.keys().cloned().collect()
    {
        return Err(JournalError::Unreferenced);
    }
    Ok(snapshot)
}

fn verify_inventory_limits(inventory: &InventoryFiles) -> Result<(), JournalError> {
    if inventory.transitions.len() > MAX_TRANSITIONS
        || inventory.leaves.len() > MAX_LEAVES
        || inventory.signatures.len() > MAX_SIGNATURES
    {
        return Err(JournalError::Limit);
    }
    let total = inventory
        .leaves
        .values()
        .chain(inventory.signatures.values())
        .chain(inventory.transitions.values().map(|file| &file.bytes))
        .try_fold(FORMAT_BYTES.len(), |sum, bytes| {
            sum.checked_add(bytes.len())
        })
        .ok_or(JournalError::Limit)?;
    if total > MAX_TOTAL_BYTES {
        return Err(JournalError::Limit);
    }
    Ok(())
}

fn verify_content_addresses(
    objects: &BTreeMap<String, Vec<u8>>,
    signature: bool,
) -> Result<(), JournalError> {
    for (digest, bytes) in objects {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || digest != &sha256_hex(bytes)
            || (signature && bytes.len() != 64)
            || (!signature && (bytes.is_empty() || bytes.len() > MAX_CANONICAL_BYTES))
        {
            return Err(JournalError::Shape);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn reduce_transition(
    snapshot: &VerifiedSnapshot,
    transition: &Transition,
    inventory: &InventoryFiles,
    pinned_public_key: &[u8; 32],
    referenced_leaves: &mut BTreeSet<String>,
    referenced_signatures: &mut BTreeSet<String>,
    facts: &mut UniqueFacts,
) -> Result<VerifiedState, JournalError> {
    match transition {
        Transition::CandidateRegistered(record) => {
            if !matches!(
                snapshot.state,
                VerifiedState::Empty
                    | VerifiedState::CandidateExpired { .. }
                    | VerifiedState::ApprovalExpired { .. }
            ) || record.prior_state != snapshot.state.name()
            {
                return Err(JournalError::State);
            }
            let candidate = load_candidate(
                &inventory.leaves,
                &record.candidate_sha256,
                referenced_leaves,
            )?;
            verify_candidate_against_registration(&candidate, record)?;
            if !facts.operation_ids.insert(candidate.operation_id.clone())
                || !facts
                    .authorization_nonces
                    .insert(candidate.authorization_nonce.clone())
                || !facts
                    .envelope_digests
                    .insert(candidate.envelope_sha256.clone())
                || !facts
                    .authority_incarnations
                    .insert(candidate.operation_authority_incarnation_sha256.clone())
            {
                return Err(JournalError::State);
            }
            Ok(VerifiedState::CandidateRegistered {
                candidate_sha256: record.candidate_sha256.clone(),
                candidate: Box::new(candidate),
            })
        }
        Transition::Approved(record) => {
            let (candidate_sha256, candidate) = match &snapshot.state {
                VerifiedState::CandidateRegistered {
                    candidate_sha256,
                    candidate,
                } => (candidate_sha256, candidate),
                _ => return Err(JournalError::State),
            };
            if record.prior_state != snapshot.state.name()
                || &record.candidate_sha256 != candidate_sha256
                || !registration_tuple_matches_approved(candidate, record)
            {
                return Err(JournalError::State);
            }
            let grant = load_grant(
                &inventory.leaves,
                &record.approval_grant_sha256,
                referenced_leaves,
            )?;
            let grant_signature = load_signature(
                &inventory.signatures,
                &record.approval_grant_signature_sha256,
                referenced_signatures,
            )?;
            verify_grant(&grant, &grant_signature, pinned_public_key)?;
            if grant.detached_signature_sha256 != record.approval_grant_signature_sha256
                || grant.issued_at != record.trusted_at
                || !grant_matches_candidate(&grant, candidate)
                || !grant_expiry_is_exact(candidate, &grant)?
                || !facts
                    .authentication_sessions
                    .insert(grant.os_authentication_session_sha256.clone())
            {
                return Err(JournalError::State);
            }
            Ok(VerifiedState::Approved {
                candidate_sha256: candidate_sha256.clone(),
                candidate: candidate.clone(),
                grant_sha256: record.approval_grant_sha256.clone(),
                grant_signature_sha256: record.approval_grant_signature_sha256.clone(),
                grant: Box::new(grant),
                grant_signature,
            })
        }
        Transition::Consumed(record) => {
            let (
                candidate_sha256,
                candidate,
                grant_sha256,
                grant_signature_sha256,
                grant,
                grant_signature,
            ) = match &snapshot.state {
                VerifiedState::Approved {
                    candidate_sha256,
                    candidate,
                    grant_sha256,
                    grant_signature_sha256,
                    grant,
                    grant_signature,
                } => (
                    candidate_sha256,
                    candidate,
                    grant_sha256,
                    grant_signature_sha256,
                    grant,
                    grant_signature,
                ),
                _ => return Err(JournalError::State),
            };
            if record.prior_state != snapshot.state.name()
                || &record.candidate_sha256 != candidate_sha256
                || &record.approval_grant_sha256 != grant_sha256
                || &record.approval_grant_signature_sha256 != grant_signature_sha256
                || !registration_tuple_matches_consumed(candidate, record)
            {
                return Err(JournalError::State);
            }
            let ticket = load_ticket(
                &inventory.leaves,
                &record.execution_ticket_sha256,
                referenced_leaves,
            )?;
            let ticket_signature = load_signature(
                &inventory.signatures,
                &record.execution_ticket_signature_sha256,
                referenced_signatures,
            )?;
            verify_ticket(&ticket, &ticket_signature, pinned_public_key)?;
            if ticket.detached_signature_sha256 != record.execution_ticket_signature_sha256
                || ticket.consumed_at != record.trusted_at
                || ticket.approval_grant_signature_sha256 != *grant_signature_sha256
                || !ticket_matches_grant(&ticket, grant)
                || sha256_hex(grant_signature) != ticket.approval_grant_signature_sha256
                || !facts.ticket_nonces.insert(ticket.ticket_nonce.clone())
            {
                return Err(JournalError::State);
            }
            Ok(VerifiedState::Consumed {
                candidate_sha256: candidate_sha256.clone(),
                candidate: candidate.clone(),
                grant_sha256: grant_sha256.clone(),
                grant_signature_sha256: grant_signature_sha256.clone(),
                grant: grant.clone(),
                ticket_sha256: record.execution_ticket_sha256.clone(),
                ticket_signature_sha256: record.execution_ticket_signature_sha256.clone(),
                ticket: Box::new(ticket),
            })
        }
        Transition::CandidateExpired(record) => {
            let (candidate_sha256, candidate) = match &snapshot.state {
                VerifiedState::CandidateRegistered {
                    candidate_sha256,
                    candidate,
                } => (candidate_sha256, candidate),
                _ => return Err(JournalError::State),
            };
            if record.prior_state != snapshot.state.name()
                || &record.candidate_sha256 != candidate_sha256
                || !registration_tuple_matches_candidate_closure(candidate, record)
                || record.cutoff_at != candidate.cutoff_at
                || derive_candidate_close_challenge(
                    &snapshot.transition_sha256,
                    candidate_sha256,
                    &candidate.approval_challenge_sha256,
                )? != record.action_challenge_sha256
                || !facts
                    .authentication_sessions
                    .insert(record.os_authentication_session_sha256.clone())
                || !insert_closing_incarnation(
                    facts,
                    candidate,
                    &record.closing_authority_incarnation_sha256,
                )
            {
                return Err(JournalError::State);
            }
            Ok(VerifiedState::CandidateExpired {
                candidate_sha256: candidate_sha256.clone(),
                candidate: candidate.clone(),
            })
        }
        Transition::ApprovalExpired(record) => {
            let (candidate_sha256, candidate, grant_sha256, grant_signature_sha256, grant) =
                match &snapshot.state {
                    VerifiedState::Approved {
                        candidate_sha256,
                        candidate,
                        grant_sha256,
                        grant_signature_sha256,
                        grant,
                        ..
                    } => (
                        candidate_sha256,
                        candidate,
                        grant_sha256,
                        grant_signature_sha256,
                        grant,
                    ),
                    _ => return Err(JournalError::State),
                };
            if record.prior_state != snapshot.state.name()
                || &record.candidate_sha256 != candidate_sha256
                || &record.approval_grant_sha256 != grant_sha256
                || &record.approval_grant_signature_sha256 != grant_signature_sha256
                || !registration_tuple_matches_approval_closure(candidate, record)
                || record.cutoff_at != grant.expires_at
                || derive_approval_close_challenge(
                    &snapshot.transition_sha256,
                    candidate_sha256,
                    &candidate.approval_challenge_sha256,
                    grant_sha256,
                    grant_signature_sha256,
                )? != record.action_challenge_sha256
                || !facts
                    .authentication_sessions
                    .insert(record.os_authentication_session_sha256.clone())
                || !insert_closing_incarnation(
                    facts,
                    candidate,
                    &record.closing_authority_incarnation_sha256,
                )
            {
                return Err(JournalError::State);
            }
            Ok(VerifiedState::ApprovalExpired {
                candidate_sha256: candidate_sha256.clone(),
                candidate: candidate.clone(),
                grant_sha256: grant_sha256.clone(),
                grant_signature_sha256: grant_signature_sha256.clone(),
                grant: grant.clone(),
            })
        }
    }
}

fn load_candidate(
    leaves: &BTreeMap<String, Vec<u8>>,
    digest: &str,
    referenced: &mut BTreeSet<String>,
) -> Result<Candidate, JournalError> {
    referenced.insert(digest.to_owned());
    Candidate::decode(leaves.get(digest).ok_or(JournalError::Shape)?).map_err(JournalError::from)
}

fn load_grant(
    leaves: &BTreeMap<String, Vec<u8>>,
    digest: &str,
    referenced: &mut BTreeSet<String>,
) -> Result<ApprovalGrant, JournalError> {
    referenced.insert(digest.to_owned());
    ApprovalGrant::decode(leaves.get(digest).ok_or(JournalError::Shape)?)
        .map_err(JournalError::from)
}

fn load_ticket(
    leaves: &BTreeMap<String, Vec<u8>>,
    digest: &str,
    referenced: &mut BTreeSet<String>,
) -> Result<ExecutionTicket, JournalError> {
    referenced.insert(digest.to_owned());
    ExecutionTicket::decode(leaves.get(digest).ok_or(JournalError::Shape)?)
        .map_err(JournalError::from)
}

fn load_signature(
    signatures: &BTreeMap<String, Vec<u8>>,
    digest: &str,
    referenced: &mut BTreeSet<String>,
) -> Result<[u8; 64], JournalError> {
    referenced.insert(digest.to_owned());
    signatures
        .get(digest)
        .ok_or(JournalError::Shape)?
        .as_slice()
        .try_into()
        .map_err(|_| JournalError::Shape)
}

fn verify_candidate_against_registration(
    candidate: &Candidate,
    transition: &crate::records::CandidateRegisteredTransition,
) -> Result<(), JournalError> {
    let mut reconstructed = candidate.clone();
    seal_candidate(&mut reconstructed, &candidate.stored_at).map_err(|_| JournalError::State)?;
    if reconstructed != *candidate
        || candidate.stored_at != transition.trusted_at
        || candidate.operation_id != transition.operation_id
        || candidate.authorization_nonce != transition.authorization_nonce
        || candidate.envelope_sha256 != transition.envelope_sha256
        || candidate.operation_authority_incarnation_sha256
            != transition.operation_authority_incarnation_sha256
        || candidate.candidate_binding_sha256 != transition.candidate_binding_sha256
        || candidate.approval_challenge_sha256 != transition.approval_challenge_sha256
    {
        return Err(JournalError::State);
    }
    Ok(())
}

fn grant_expiry_is_exact(
    candidate: &Candidate,
    grant: &ApprovalGrant,
) -> Result<bool, JournalError> {
    let envelope_expiry = validate_whole_timestamp(&candidate.envelope_expires_at)?;
    let external_expiry =
        validate_millisecond_timestamp(&candidate.external_exclusive_window_expires_at)?;
    let authenticated_at = validate_whole_timestamp(&grant.authenticated_at)?;
    let issued_at = validate_whole_timestamp(&grant.issued_at)?;
    let (authentication_deadline_text, authentication_deadline) =
        add_whole_seconds(authenticated_at, 300)?;
    let (issue_deadline_text, issue_deadline) = add_whole_seconds(issued_at, 900)?;
    let candidates = [
        (candidate.envelope_expires_at.as_str(), envelope_expiry),
        (
            candidate.external_exclusive_window_expires_at.as_str(),
            external_expiry,
        ),
        (
            authentication_deadline_text.as_str(),
            authentication_deadline,
        ),
        (issue_deadline_text.as_str(), issue_deadline),
    ];
    let expected = select_minimum(&candidates)?;
    Ok(grant.expires_at == expected)
}

fn registration_tuple_matches_approved(
    candidate: &Candidate,
    transition: &crate::records::ApprovedTransition,
) -> bool {
    candidate.operation_id == transition.operation_id
        && candidate.authorization_nonce == transition.authorization_nonce
        && candidate.envelope_sha256 == transition.envelope_sha256
        && candidate.operation_authority_incarnation_sha256
            == transition.operation_authority_incarnation_sha256
}

fn registration_tuple_matches_consumed(
    candidate: &Candidate,
    transition: &crate::records::ConsumedTransition,
) -> bool {
    candidate.operation_id == transition.operation_id
        && candidate.authorization_nonce == transition.authorization_nonce
        && candidate.envelope_sha256 == transition.envelope_sha256
        && candidate.operation_authority_incarnation_sha256
            == transition.operation_authority_incarnation_sha256
}

fn registration_tuple_matches_candidate_closure(
    candidate: &Candidate,
    transition: &crate::records::CandidateExpiredTransition,
) -> bool {
    candidate.operation_id == transition.operation_id
        && candidate.authorization_nonce == transition.authorization_nonce
        && candidate.envelope_sha256 == transition.envelope_sha256
        && candidate.operation_authority_incarnation_sha256
            == transition.operation_authority_incarnation_sha256
}

fn registration_tuple_matches_approval_closure(
    candidate: &Candidate,
    transition: &crate::records::ApprovalExpiredTransition,
) -> bool {
    candidate.operation_id == transition.operation_id
        && candidate.authorization_nonce == transition.authorization_nonce
        && candidate.envelope_sha256 == transition.envelope_sha256
        && candidate.operation_authority_incarnation_sha256
            == transition.operation_authority_incarnation_sha256
}

fn insert_closing_incarnation(
    facts: &mut UniqueFacts,
    candidate: &Candidate,
    closing: &str,
) -> bool {
    closing == candidate.operation_authority_incarnation_sha256
        || facts.authority_incarnations.insert(closing.to_owned())
}
