//! One-use state reducer and opaque test-only authority capabilities.

use time::OffsetDateTime;

use crate::canonical::{
    CanonicalError, add_whole_seconds, select_minimum, validate_derived_timestamp,
    validate_millisecond_timestamp, validate_whole_timestamp,
};
use crate::crypto::{
    CryptoError, RecordSigner, sha256, sha256_hex, verify_grant, verify_ticket, verify_transition,
};
use crate::records::{
    APPROVED_SCHEMA, ApprovalGrant, ApprovedTransition, CANDIDATE_REGISTERED_SCHEMA,
    CANDIDATE_SCHEMA, CONSUMED_SCHEMA, Candidate, CandidateRegisteredTransition,
    ConsumedTransition, ExecutionTicket, GRANT_SCHEMA, TICKET_SCHEMA, Transition,
};

const APPROVAL_CHALLENGE_DOMAIN: &[u8] = b"openspell.hosted-migration-approval-challenge.v1\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StateError {
    Canonical,
    Crypto,
    Expired,
    Future,
    PolicyMismatch,
    Stale,
}

impl From<CanonicalError> for StateError {
    fn from(_: CanonicalError) -> Self {
        Self::Canonical
    }
}

impl From<CryptoError> for StateError {
    fn from(_: CryptoError) -> Self {
        Self::Crypto
    }
}

pub(crate) struct RootVerifiedPreparedEnvelope {
    candidate_sha256: String,
    external_window_observed_at: OffsetDateTime,
    pre_apply_target_observed_at: OffsetDateTime,
    pre_apply_freeze_observed_at: OffsetDateTime,
    ddl_guard_second_probe_observed_at: OffsetDateTime,
}

pub(crate) struct FreshAttendedAuthentication {
    action_challenge_sha256: String,
    operator_identity_sha256: String,
    session_sha256: String,
    authenticated_at: String,
}

#[cfg(test)]
impl RootVerifiedPreparedEnvelope {
    pub(crate) fn synthetic(
        candidate: &Candidate,
        observations: [&str; 4],
    ) -> Result<Self, StateError> {
        Ok(Self {
            candidate_sha256: sha256_hex(&candidate.encode()?),
            external_window_observed_at: validate_millisecond_timestamp(observations[0])?,
            pre_apply_target_observed_at: validate_whole_timestamp(observations[1])?,
            pre_apply_freeze_observed_at: validate_whole_timestamp(observations[2])?,
            ddl_guard_second_probe_observed_at: validate_whole_timestamp(observations[3])?,
        })
    }
}

#[cfg(test)]
impl FreshAttendedAuthentication {
    pub(crate) fn synthetic(
        action_challenge_sha256: String,
        operator_identity_sha256: String,
        session_sha256: String,
        authenticated_at: String,
    ) -> Self {
        Self {
            action_challenge_sha256,
            operator_identity_sha256,
            session_sha256,
            authenticated_at,
        }
    }
}

pub(crate) fn seal_candidate(
    candidate: &mut Candidate,
    trusted_now_text: &str,
) -> Result<(), StateError> {
    if candidate.schema_version != CANDIDATE_SCHEMA {
        return Err(StateError::Canonical);
    }
    let now = validate_whole_timestamp(trusted_now_text)?;
    let envelope_expiry = validate_whole_timestamp(&candidate.envelope_expires_at)?;
    let external_expiry =
        validate_millisecond_timestamp(&candidate.external_exclusive_window_expires_at)?;
    let (_, latest_envelope) = add_whole_seconds(now, 900)?;
    if envelope_expiry <= now || envelope_expiry > latest_envelope || external_expiry <= now {
        return Err(StateError::Expired);
    }
    candidate.stored_at = trusted_now_text.to_owned();
    candidate.cutoff_at = select_minimum(&[
        (&candidate.envelope_expires_at, envelope_expiry),
        (
            &candidate.external_exclusive_window_expires_at,
            external_expiry,
        ),
    ])?
    .to_owned();
    candidate.candidate_binding_sha256.clear();
    candidate.approval_challenge_sha256.clear();
    let binding = sha256_hex(&candidate.encode_binding_projection()?);
    candidate.candidate_binding_sha256 = binding.clone();
    let binding_bytes: [u8; 32] = hex::decode(binding)
        .map_err(|_| StateError::Canonical)?
        .try_into()
        .map_err(|_| StateError::Canonical)?;
    let mut challenge_preimage = Vec::with_capacity(APPROVAL_CHALLENGE_DOMAIN.len() + 32);
    challenge_preimage.extend_from_slice(APPROVAL_CHALLENGE_DOMAIN);
    challenge_preimage.extend_from_slice(&binding_bytes);
    candidate.approval_challenge_sha256 = hex::encode(sha256(&challenge_preimage));
    candidate.validate()?;
    Ok(())
}

pub(crate) fn approve_candidate(
    candidate: &Candidate,
    verified: &RootVerifiedPreparedEnvelope,
    authentication: &FreshAttendedAuthentication,
    trusted_now_text: &str,
    signer: &impl RecordSigner,
) -> Result<(ApprovalGrant, [u8; 64]), StateError> {
    candidate.validate()?;
    let now = validate_whole_timestamp(trusted_now_text)?;
    if verified.candidate_sha256 != sha256_hex(&candidate.encode()?)
        || authentication.action_challenge_sha256 != candidate.approval_challenge_sha256
    {
        return Err(StateError::PolicyMismatch);
    }
    for observed_at in [
        verified.external_window_observed_at,
        verified.pre_apply_target_observed_at,
        verified.pre_apply_freeze_observed_at,
        verified.ddl_guard_second_probe_observed_at,
    ] {
        let age = now - observed_at;
        if age.is_negative() {
            return Err(StateError::Future);
        }
        if age.whole_seconds() >= 60 {
            return Err(StateError::Stale);
        }
    }
    let authenticated_at = validate_whole_timestamp(&authentication.authenticated_at)?;
    let authentication_age = now - authenticated_at;
    if authentication_age.is_negative() {
        return Err(StateError::Future);
    }
    if authentication_age.whole_seconds() > 300 {
        return Err(StateError::Stale);
    }
    let envelope_expiry = validate_whole_timestamp(&candidate.envelope_expires_at)?;
    let external_expiry =
        validate_millisecond_timestamp(&candidate.external_exclusive_window_expires_at)?;
    let (authentication_deadline_text, authentication_deadline) =
        add_whole_seconds(authenticated_at, 300)?;
    let (issue_deadline_text, issue_deadline) = add_whole_seconds(now, 900)?;
    let expires_at = select_minimum(&[
        (&candidate.envelope_expires_at, envelope_expiry),
        (
            &candidate.external_exclusive_window_expires_at,
            external_expiry,
        ),
        (&authentication_deadline_text, authentication_deadline),
        (&issue_deadline_text, issue_deadline),
    ])?
    .to_owned();
    if validate_derived_timestamp(&expires_at)? <= now {
        return Err(StateError::Expired);
    }
    let public_key = signer.public_key_bytes();
    let mut grant = ApprovalGrant {
        schema_version: GRANT_SCHEMA.to_owned(),
        operation_id: candidate.operation_id.clone(),
        authorization_nonce: candidate.authorization_nonce.clone(),
        target_fingerprint: candidate.target_fingerprint.clone(),
        target_selection_sha256: candidate.target_selection_sha256.clone(),
        envelope_sha256: candidate.envelope_sha256.clone(),
        external_exclusive_window_generation: candidate.external_exclusive_window_generation,
        external_exclusive_window_evidence_sha256: candidate
            .external_exclusive_window_evidence_sha256
            .clone(),
        official_source_evidence_sha256: candidate.official_source_evidence_sha256.clone(),
        native_runtime_identity_sha256: candidate.native_runtime_identity_sha256.clone(),
        child_sandbox_policy_sha256: candidate.child_sandbox_policy_sha256.clone(),
        phase_exec_topology_policy_sha256: candidate.phase_exec_topology_policy_sha256.clone(),
        child_cgroup_policy_sha256: candidate.child_cgroup_policy_sha256.clone(),
        apply_invocation_evidence_sha256: candidate.apply_invocation_evidence_sha256.clone(),
        issued_at: trusted_now_text.to_owned(),
        expires_at,
        authenticated_operator_identity_sha256: authentication.operator_identity_sha256.clone(),
        os_authentication_session_sha256: authentication.session_sha256.clone(),
        authenticated_at: authentication.authenticated_at.clone(),
        state: "approved".to_owned(),
        issuer_public_key_sha256: sha256_hex(&public_key),
        detached_signature_sha256: String::new(),
    };
    let signature = signer.sign_approval_grant(&grant)?;
    grant.detached_signature_sha256 = sha256_hex(&signature);
    verify_grant(&grant, &signature, &public_key)?;
    Ok((grant, signature))
}

pub(crate) fn consume_grant(
    candidate: &Candidate,
    grant: &ApprovalGrant,
    grant_signature: &[u8; 64],
    trusted_now_text: &str,
    ticket_nonce: [u8; 32],
    signer: &impl RecordSigner,
) -> Result<(ExecutionTicket, [u8; 64]), StateError> {
    let public_key = signer.public_key_bytes();
    verify_grant(grant, grant_signature, &public_key)?;
    if !grant_matches_candidate(grant, candidate) {
        return Err(StateError::PolicyMismatch);
    }
    let now = validate_whole_timestamp(trusted_now_text)?;
    if now >= validate_derived_timestamp(&grant.expires_at)? {
        return Err(StateError::Expired);
    }
    let mut ticket = ExecutionTicket {
        schema_version: TICKET_SCHEMA.to_owned(),
        approval_grant_sha256: sha256_hex(&grant.encode()?),
        approval_grant_signature_sha256: sha256_hex(grant_signature),
        ticket_nonce: hex::encode(ticket_nonce),
        operation_id: grant.operation_id.clone(),
        authorization_nonce: grant.authorization_nonce.clone(),
        target_fingerprint: grant.target_fingerprint.clone(),
        target_selection_sha256: grant.target_selection_sha256.clone(),
        envelope_sha256: grant.envelope_sha256.clone(),
        external_exclusive_window_generation: grant.external_exclusive_window_generation,
        external_exclusive_window_evidence_sha256: grant
            .external_exclusive_window_evidence_sha256
            .clone(),
        official_source_evidence_sha256: grant.official_source_evidence_sha256.clone(),
        native_runtime_identity_sha256: grant.native_runtime_identity_sha256.clone(),
        child_sandbox_policy_sha256: grant.child_sandbox_policy_sha256.clone(),
        phase_exec_topology_policy_sha256: grant.phase_exec_topology_policy_sha256.clone(),
        child_cgroup_policy_sha256: grant.child_cgroup_policy_sha256.clone(),
        apply_invocation_evidence_sha256: grant.apply_invocation_evidence_sha256.clone(),
        consumed_at: trusted_now_text.to_owned(),
        expires_at: grant.expires_at.clone(),
        state: "consumed".to_owned(),
        issuer_public_key_sha256: sha256_hex(&public_key),
        detached_signature_sha256: String::new(),
    };
    let signature = signer.sign_execution_ticket(&ticket)?;
    ticket.detached_signature_sha256 = sha256_hex(&signature);
    verify_ticket(&ticket, &signature, &public_key)?;
    Ok((ticket, signature))
}

fn grant_matches_candidate(grant: &ApprovalGrant, candidate: &Candidate) -> bool {
    grant.operation_id == candidate.operation_id
        && grant.authorization_nonce == candidate.authorization_nonce
        && grant.target_fingerprint == candidate.target_fingerprint
        && grant.target_selection_sha256 == candidate.target_selection_sha256
        && grant.envelope_sha256 == candidate.envelope_sha256
        && grant.external_exclusive_window_generation
            == candidate.external_exclusive_window_generation
        && grant.external_exclusive_window_evidence_sha256
            == candidate.external_exclusive_window_evidence_sha256
        && grant.official_source_evidence_sha256 == candidate.official_source_evidence_sha256
        && grant.native_runtime_identity_sha256 == candidate.native_runtime_identity_sha256
        && grant.child_sandbox_policy_sha256 == candidate.child_sandbox_policy_sha256
        && grant.phase_exec_topology_policy_sha256 == candidate.phase_exec_topology_policy_sha256
        && grant.child_cgroup_policy_sha256 == candidate.child_cgroup_policy_sha256
        && grant.apply_invocation_evidence_sha256 == candidate.apply_invocation_evidence_sha256
}

pub(crate) fn sign_candidate_registered_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    prior_state: String,
    trusted_at: String,
    signer: &impl RecordSigner,
) -> Result<(Transition, [u8; 64]), StateError> {
    let public_key = signer.public_key_bytes();
    let mut record = CandidateRegisteredTransition {
        schema_version: CANDIDATE_REGISTERED_SCHEMA.to_owned(),
        generation,
        previous_transition_sha256,
        transition_kind: "candidate_registered".to_owned(),
        prior_state,
        resulting_state: "candidate_registered".to_owned(),
        candidate_sha256,
        operation_id: candidate.operation_id.clone(),
        authorization_nonce: candidate.authorization_nonce.clone(),
        envelope_sha256: candidate.envelope_sha256.clone(),
        operation_authority_incarnation_sha256: candidate
            .operation_authority_incarnation_sha256
            .clone(),
        candidate_binding_sha256: candidate.candidate_binding_sha256.clone(),
        approval_challenge_sha256: candidate.approval_challenge_sha256.clone(),
        trusted_at,
        issuer_public_key_sha256: sha256_hex(&public_key),
        detached_signature_sha256: String::new(),
    };
    let signature = signer.sign_candidate_registered_transition(&record)?;
    record.detached_signature_sha256 = sha256_hex(&signature);
    let transition = Transition::CandidateRegistered(record);
    verify_transition(&transition, &signature, &public_key)?;
    Ok((transition, signature))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sign_approved_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    grant: &ApprovalGrant,
    grant_sha256: String,
    grant_signature_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    trusted_at: String,
    signer: &impl RecordSigner,
) -> Result<(Transition, [u8; 64]), StateError> {
    let public_key = signer.public_key_bytes();
    let mut record = ApprovedTransition {
        schema_version: APPROVED_SCHEMA.to_owned(),
        generation,
        previous_transition_sha256,
        transition_kind: "approved".to_owned(),
        prior_state: "candidate_registered".to_owned(),
        resulting_state: "approved".to_owned(),
        candidate_sha256,
        approval_grant_sha256: grant_sha256,
        approval_grant_signature_sha256: grant_signature_sha256,
        operation_id: grant.operation_id.clone(),
        authorization_nonce: grant.authorization_nonce.clone(),
        envelope_sha256: grant.envelope_sha256.clone(),
        operation_authority_incarnation_sha256: candidate
            .operation_authority_incarnation_sha256
            .clone(),
        trusted_at,
        issuer_public_key_sha256: sha256_hex(&public_key),
        detached_signature_sha256: String::new(),
    };
    let signature = signer.sign_approved_transition(&record)?;
    record.detached_signature_sha256 = sha256_hex(&signature);
    let transition = Transition::Approved(record);
    verify_transition(&transition, &signature, &public_key)?;
    Ok((transition, signature))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sign_consumed_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    grant: &ApprovalGrant,
    grant_sha256: String,
    grant_signature_sha256: String,
    ticket: &ExecutionTicket,
    ticket_sha256: String,
    ticket_signature_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    trusted_at: String,
    signer: &impl RecordSigner,
) -> Result<(Transition, [u8; 64]), StateError> {
    let public_key = signer.public_key_bytes();
    let mut record = ConsumedTransition {
        schema_version: CONSUMED_SCHEMA.to_owned(),
        generation,
        previous_transition_sha256,
        transition_kind: "consumed".to_owned(),
        prior_state: "approved".to_owned(),
        resulting_state: "consumed".to_owned(),
        candidate_sha256,
        approval_grant_sha256: grant_sha256,
        approval_grant_signature_sha256: grant_signature_sha256,
        execution_ticket_sha256: ticket_sha256,
        execution_ticket_signature_sha256: ticket_signature_sha256,
        operation_id: ticket.operation_id.clone(),
        authorization_nonce: ticket.authorization_nonce.clone(),
        envelope_sha256: ticket.envelope_sha256.clone(),
        operation_authority_incarnation_sha256: candidate
            .operation_authority_incarnation_sha256
            .clone(),
        trusted_at,
        issuer_public_key_sha256: sha256_hex(&public_key),
        detached_signature_sha256: String::new(),
    };
    if grant.operation_id != ticket.operation_id
        || grant.authorization_nonce != ticket.authorization_nonce
        || grant.envelope_sha256 != ticket.envelope_sha256
    {
        return Err(StateError::PolicyMismatch);
    }
    let signature = signer.sign_consumed_transition(&record)?;
    record.detached_signature_sha256 = sha256_hex(&signature);
    let transition = Transition::Consumed(record);
    verify_transition(&transition, &signature, &public_key)?;
    Ok((transition, signature))
}
