//! One-use state reducer and opaque test-only authority capabilities.

use time::OffsetDateTime;

use crate::canonical::{
    CanonicalError, add_whole_seconds, select_minimum, validate_derived_timestamp,
    validate_millisecond_timestamp, validate_whole_timestamp,
};
use crate::crypto::{
    CryptoError, RecordSigner, sha256, sha256_hex, verify_grant, verify_ticket, verify_transition,
};
use crate::journal::PostArtifactPublication;
use crate::records::{
    APPROVAL_EXPIRED_SCHEMA, APPROVED_SCHEMA, ApprovalExpiredTransition, ApprovalGrant,
    ApprovedTransition, CANDIDATE_EXPIRED_SCHEMA, CANDIDATE_REGISTERED_SCHEMA, CANDIDATE_SCHEMA,
    CONSUMED_SCHEMA, Candidate, CandidateExpiredTransition, CandidateRegisteredTransition,
    ConsumedTransition, ExecutionTicket, GRANT_SCHEMA, TICKET_SCHEMA, Transition,
};

const APPROVAL_CHALLENGE_DOMAIN: &[u8] = b"openspell.hosted-migration-approval-challenge.v1\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StateError {
    Canonical,
    Crypto,
    Expired,
    Future,
    NotExpired,
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

impl FreshAttendedAuthentication {
    pub(crate) fn session_sha256(&self) -> &str {
        &self.session_sha256
    }

    pub(crate) fn action_challenge_sha256(&self) -> &str {
        &self.action_challenge_sha256
    }
}

impl RootVerifiedPreparedEnvelope {
    pub(crate) fn matches_candidate(&self, candidate: &Candidate) -> Result<bool, StateError> {
        Ok(self.candidate_sha256 == sha256_hex(&candidate.encode()?))
    }
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

pub(crate) struct ApprovalPlan {
    grant: ApprovalGrant,
}

impl ApprovalPlan {
    pub(crate) fn projected_signed(&self) -> ApprovalGrant {
        let mut projected = self.grant.clone();
        projected.detached_signature_sha256 = "0".repeat(64);
        projected
    }

    pub(crate) fn expected_signed_bytes(&self) -> Result<usize, StateError> {
        Ok(self.projected_signed().encode()?.len())
    }

    pub(crate) fn sign(
        mut self,
        signer: &impl RecordSigner,
        pinned_public_key: &[u8; 32],
    ) -> Result<(ApprovalGrant, [u8; 64]), StateError> {
        if signer.public_key_bytes() != *pinned_public_key {
            return Err(StateError::PolicyMismatch);
        }
        let signature = signer.sign_approval_grant(&self.grant)?;
        self.grant.detached_signature_sha256 = sha256_hex(&signature);
        verify_grant(&self.grant, &signature, pinned_public_key)?;
        Ok((self.grant, signature))
    }
}

pub(crate) fn plan_approval(
    candidate: &Candidate,
    verified: &RootVerifiedPreparedEnvelope,
    authentication: &FreshAttendedAuthentication,
    trusted_now_text: &str,
    pinned_public_key: &[u8; 32],
) -> Result<ApprovalPlan, StateError> {
    candidate.validate()?;
    let now = validate_whole_timestamp(trusted_now_text)?;
    if !verified.matches_candidate(candidate)?
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
    let grant = ApprovalGrant {
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
        issuer_public_key_sha256: sha256_hex(pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    Ok(ApprovalPlan { grant })
}

#[cfg(test)]
pub(crate) fn approve_candidate(
    candidate: &Candidate,
    verified: &RootVerifiedPreparedEnvelope,
    authentication: &FreshAttendedAuthentication,
    trusted_now_text: &str,
    signer: &impl RecordSigner,
) -> Result<(ApprovalGrant, [u8; 64]), StateError> {
    plan_approval(
        candidate,
        verified,
        authentication,
        trusted_now_text,
        &signer.public_key_bytes(),
    )?
    .sign(signer, &signer.public_key_bytes())
}

pub(crate) struct TicketPlan {
    ticket: ExecutionTicket,
}

impl TicketPlan {
    pub(crate) fn projected_signed(&self) -> ExecutionTicket {
        let mut projected = self.ticket.clone();
        projected.detached_signature_sha256 = "0".repeat(64);
        projected
    }

    pub(crate) fn expected_signed_bytes(&self) -> Result<usize, StateError> {
        Ok(self.projected_signed().encode()?.len())
    }

    pub(crate) fn sign(
        mut self,
        signer: &impl RecordSigner,
        pinned_public_key: &[u8; 32],
    ) -> Result<(ExecutionTicket, [u8; 64]), StateError> {
        if signer.public_key_bytes() != *pinned_public_key {
            return Err(StateError::PolicyMismatch);
        }
        let signature = signer.sign_execution_ticket(&self.ticket)?;
        self.ticket.detached_signature_sha256 = sha256_hex(&signature);
        verify_ticket(&self.ticket, &signature, pinned_public_key)?;
        Ok((self.ticket, signature))
    }
}

pub(crate) fn plan_ticket(
    candidate: &Candidate,
    grant: &ApprovalGrant,
    grant_signature: &[u8; 64],
    trusted_now_text: &str,
    ticket_nonce: [u8; 32],
    pinned_public_key: &[u8; 32],
) -> Result<TicketPlan, StateError> {
    verify_grant(grant, grant_signature, pinned_public_key)?;
    if !grant_matches_candidate(grant, candidate) {
        return Err(StateError::PolicyMismatch);
    }
    let now = validate_whole_timestamp(trusted_now_text)?;
    if now >= validate_derived_timestamp(&grant.expires_at)? {
        return Err(StateError::Expired);
    }
    let ticket = ExecutionTicket {
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
        issuer_public_key_sha256: sha256_hex(pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    Ok(TicketPlan { ticket })
}

#[cfg(test)]
pub(crate) fn consume_grant(
    candidate: &Candidate,
    grant: &ApprovalGrant,
    grant_signature: &[u8; 64],
    trusted_now_text: &str,
    ticket_nonce: [u8; 32],
    signer: &impl RecordSigner,
) -> Result<(ExecutionTicket, [u8; 64]), StateError> {
    plan_ticket(
        candidate,
        grant,
        grant_signature,
        trusted_now_text,
        ticket_nonce,
        &signer.public_key_bytes(),
    )?
    .sign(signer, &signer.public_key_bytes())
}

pub(crate) fn grant_matches_candidate(grant: &ApprovalGrant, candidate: &Candidate) -> bool {
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

pub(crate) fn ticket_matches_grant(ticket: &ExecutionTicket, grant: &ApprovalGrant) -> bool {
    ticket.approval_grant_sha256
        == grant
            .encode()
            .map_or(String::new(), |bytes| sha256_hex(&bytes))
        && ticket.operation_id == grant.operation_id
        && ticket.authorization_nonce == grant.authorization_nonce
        && ticket.target_fingerprint == grant.target_fingerprint
        && ticket.target_selection_sha256 == grant.target_selection_sha256
        && ticket.envelope_sha256 == grant.envelope_sha256
        && ticket.external_exclusive_window_generation == grant.external_exclusive_window_generation
        && ticket.external_exclusive_window_evidence_sha256
            == grant.external_exclusive_window_evidence_sha256
        && ticket.official_source_evidence_sha256 == grant.official_source_evidence_sha256
        && ticket.native_runtime_identity_sha256 == grant.native_runtime_identity_sha256
        && ticket.child_sandbox_policy_sha256 == grant.child_sandbox_policy_sha256
        && ticket.phase_exec_topology_policy_sha256 == grant.phase_exec_topology_policy_sha256
        && ticket.child_cgroup_policy_sha256 == grant.child_cgroup_policy_sha256
        && ticket.apply_invocation_evidence_sha256 == grant.apply_invocation_evidence_sha256
        && ticket.expires_at == grant.expires_at
}

pub(crate) struct TransitionPlan {
    transition: Transition,
}

impl TransitionPlan {
    pub(crate) fn expected_signed_bytes(&self) -> Result<usize, StateError> {
        let mut projected = self.transition.clone();
        set_transition_signature_digest(&mut projected, "0".repeat(64));
        Ok(projected.encode()?.len())
    }

    pub(crate) fn sign(
        mut self,
        _published: PostArtifactPublication,
        signer: &impl RecordSigner,
        pinned_public_key: &[u8; 32],
    ) -> Result<(Transition, [u8; 64]), StateError> {
        if signer.public_key_bytes() != *pinned_public_key {
            return Err(StateError::PolicyMismatch);
        }
        let signature = match &self.transition {
            Transition::CandidateRegistered(record) => {
                signer.sign_candidate_registered_transition(record)?
            }
            Transition::Approved(record) => signer.sign_approved_transition(record)?,
            Transition::Consumed(record) => signer.sign_consumed_transition(record)?,
            Transition::CandidateExpired(record) => {
                signer.sign_candidate_expired_transition(record)?
            }
            Transition::ApprovalExpired(record) => {
                signer.sign_approval_expired_transition(record)?
            }
        };
        set_transition_signature_digest(&mut self.transition, sha256_hex(&signature));
        verify_transition(&self.transition, &signature, pinned_public_key)?;
        Ok((self.transition, signature))
    }
}

fn set_transition_signature_digest(transition: &mut Transition, digest: String) {
    match transition {
        Transition::CandidateRegistered(record) => record.detached_signature_sha256 = digest,
        Transition::Approved(record) => record.detached_signature_sha256 = digest,
        Transition::Consumed(record) => record.detached_signature_sha256 = digest,
        Transition::CandidateExpired(record) => record.detached_signature_sha256 = digest,
        Transition::ApprovalExpired(record) => record.detached_signature_sha256 = digest,
    }
}

#[cfg(test)]
pub(crate) fn sign_candidate_registered_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    prior_state: String,
    trusted_at: String,
    signer: &impl RecordSigner,
) -> Result<(Transition, [u8; 64]), StateError> {
    plan_candidate_registered_transition(
        candidate,
        candidate_sha256,
        generation,
        previous_transition_sha256,
        prior_state,
        trusted_at,
        signer.public_key_bytes(),
    )?
    .sign(
        PostArtifactPublication::synthetic(),
        signer,
        &signer.public_key_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_candidate_registered_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    prior_state: String,
    trusted_at: String,
    pinned_public_key: [u8; 32],
) -> Result<TransitionPlan, StateError> {
    let record = CandidateRegisteredTransition {
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
        issuer_public_key_sha256: sha256_hex(&pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    Ok(TransitionPlan {
        transition: Transition::CandidateRegistered(record),
    })
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
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
    plan_approved_transition(
        candidate,
        candidate_sha256,
        grant,
        grant_sha256,
        grant_signature_sha256,
        generation,
        previous_transition_sha256,
        trusted_at,
        signer.public_key_bytes(),
    )?
    .sign(
        PostArtifactPublication::synthetic(),
        signer,
        &signer.public_key_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_approved_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    grant: &ApprovalGrant,
    grant_sha256: String,
    grant_signature_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    trusted_at: String,
    pinned_public_key: [u8; 32],
) -> Result<TransitionPlan, StateError> {
    let record = ApprovedTransition {
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
        issuer_public_key_sha256: sha256_hex(&pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    Ok(TransitionPlan {
        transition: Transition::Approved(record),
    })
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
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
    plan_consumed_transition(
        candidate,
        candidate_sha256,
        grant,
        grant_sha256,
        grant_signature_sha256,
        ticket,
        ticket_sha256,
        ticket_signature_sha256,
        generation,
        previous_transition_sha256,
        trusted_at,
        signer.public_key_bytes(),
    )?
    .sign(
        PostArtifactPublication::synthetic(),
        signer,
        &signer.public_key_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_consumed_transition(
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
    pinned_public_key: [u8; 32],
) -> Result<TransitionPlan, StateError> {
    let record = ConsumedTransition {
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
        issuer_public_key_sha256: sha256_hex(&pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    if grant.operation_id != ticket.operation_id
        || grant.authorization_nonce != ticket.authorization_nonce
        || grant.envelope_sha256 != ticket.envelope_sha256
    {
        return Err(StateError::PolicyMismatch);
    }
    Ok(TransitionPlan {
        transition: Transition::Consumed(record),
    })
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(crate) fn close_candidate(
    candidate: &Candidate,
    candidate_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    closing_authority_incarnation_sha256: String,
    action_challenge_sha256: String,
    authentication: &FreshAttendedAuthentication,
    trusted_at: String,
    signer: &impl RecordSigner,
) -> Result<(Transition, [u8; 64]), StateError> {
    plan_close_candidate_transition(
        candidate,
        candidate_sha256,
        generation,
        previous_transition_sha256,
        closing_authority_incarnation_sha256,
        action_challenge_sha256,
        authentication,
        trusted_at,
        signer.public_key_bytes(),
    )?
    .sign(
        PostArtifactPublication::synthetic(),
        signer,
        &signer.public_key_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_close_candidate_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    closing_authority_incarnation_sha256: String,
    action_challenge_sha256: String,
    authentication: &FreshAttendedAuthentication,
    trusted_at: String,
    pinned_public_key: [u8; 32],
) -> Result<TransitionPlan, StateError> {
    candidate.validate()?;
    let expected_challenge = derive_candidate_close_challenge(
        &previous_transition_sha256,
        &candidate_sha256,
        &candidate.approval_challenge_sha256,
    )?;
    verify_closure_authentication(
        authentication,
        &action_challenge_sha256,
        &expected_challenge,
        &trusted_at,
        &candidate.cutoff_at,
    )?;
    let record = CandidateExpiredTransition {
        schema_version: CANDIDATE_EXPIRED_SCHEMA.to_owned(),
        generation,
        previous_transition_sha256,
        transition_kind: "candidate_expired".to_owned(),
        prior_state: "candidate_registered".to_owned(),
        resulting_state: "candidate_expired".to_owned(),
        candidate_sha256,
        operation_id: candidate.operation_id.clone(),
        authorization_nonce: candidate.authorization_nonce.clone(),
        envelope_sha256: candidate.envelope_sha256.clone(),
        operation_authority_incarnation_sha256: candidate
            .operation_authority_incarnation_sha256
            .clone(),
        closing_authority_incarnation_sha256,
        action_challenge_sha256,
        authenticated_operator_identity_sha256: authentication.operator_identity_sha256.clone(),
        os_authentication_session_sha256: authentication.session_sha256.clone(),
        authenticated_at: authentication.authenticated_at.clone(),
        cutoff_at: candidate.cutoff_at.clone(),
        trusted_at,
        issuer_public_key_sha256: sha256_hex(&pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    Ok(TransitionPlan {
        transition: Transition::CandidateExpired(record),
    })
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub(crate) fn close_approval(
    candidate: &Candidate,
    candidate_sha256: String,
    grant: &ApprovalGrant,
    grant_signature: &[u8; 64],
    grant_sha256: String,
    grant_signature_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    closing_authority_incarnation_sha256: String,
    action_challenge_sha256: String,
    authentication: &FreshAttendedAuthentication,
    trusted_at: String,
    signer: &impl RecordSigner,
) -> Result<(Transition, [u8; 64]), StateError> {
    plan_close_approval_transition(
        candidate,
        candidate_sha256,
        grant,
        grant_signature,
        grant_sha256,
        grant_signature_sha256,
        generation,
        previous_transition_sha256,
        closing_authority_incarnation_sha256,
        action_challenge_sha256,
        authentication,
        trusted_at,
        signer.public_key_bytes(),
    )?
    .sign(
        PostArtifactPublication::synthetic(),
        signer,
        &signer.public_key_bytes(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_close_approval_transition(
    candidate: &Candidate,
    candidate_sha256: String,
    grant: &ApprovalGrant,
    grant_signature: &[u8; 64],
    grant_sha256: String,
    grant_signature_sha256: String,
    generation: u64,
    previous_transition_sha256: String,
    closing_authority_incarnation_sha256: String,
    action_challenge_sha256: String,
    authentication: &FreshAttendedAuthentication,
    trusted_at: String,
    pinned_public_key: [u8; 32],
) -> Result<TransitionPlan, StateError> {
    verify_grant(grant, grant_signature, &pinned_public_key)?;
    if !grant_matches_candidate(grant, candidate)
        || grant_sha256 != sha256_hex(&grant.encode()?)
        || grant_signature_sha256 != sha256_hex(grant_signature)
    {
        return Err(StateError::PolicyMismatch);
    }
    let expected_challenge = derive_approval_close_challenge(
        &previous_transition_sha256,
        &candidate_sha256,
        &candidate.approval_challenge_sha256,
        &grant_sha256,
        &grant_signature_sha256,
    )?;
    verify_closure_authentication(
        authentication,
        &action_challenge_sha256,
        &expected_challenge,
        &trusted_at,
        &grant.expires_at,
    )?;
    let record = ApprovalExpiredTransition {
        schema_version: APPROVAL_EXPIRED_SCHEMA.to_owned(),
        generation,
        previous_transition_sha256,
        transition_kind: "approval_expired".to_owned(),
        prior_state: "approved".to_owned(),
        resulting_state: "approval_expired".to_owned(),
        candidate_sha256,
        approval_grant_sha256: grant_sha256,
        approval_grant_signature_sha256: grant_signature_sha256,
        operation_id: candidate.operation_id.clone(),
        authorization_nonce: candidate.authorization_nonce.clone(),
        envelope_sha256: candidate.envelope_sha256.clone(),
        operation_authority_incarnation_sha256: candidate
            .operation_authority_incarnation_sha256
            .clone(),
        closing_authority_incarnation_sha256,
        action_challenge_sha256,
        authenticated_operator_identity_sha256: authentication.operator_identity_sha256.clone(),
        os_authentication_session_sha256: authentication.session_sha256.clone(),
        authenticated_at: authentication.authenticated_at.clone(),
        cutoff_at: grant.expires_at.clone(),
        trusted_at,
        issuer_public_key_sha256: sha256_hex(&pinned_public_key),
        detached_signature_sha256: String::new(),
    };
    Ok(TransitionPlan {
        transition: Transition::ApprovalExpired(record),
    })
}

fn verify_closure_authentication(
    authentication: &FreshAttendedAuthentication,
    request_challenge: &str,
    expected_challenge: &str,
    trusted_at: &str,
    cutoff_at: &str,
) -> Result<(), StateError> {
    if request_challenge != expected_challenge
        || authentication.action_challenge_sha256 != expected_challenge
    {
        return Err(StateError::PolicyMismatch);
    }
    validate_closure_time(authentication, trusted_at, cutoff_at)
}

pub(crate) fn validate_closure_time(
    authentication: &FreshAttendedAuthentication,
    trusted_at: &str,
    cutoff_at: &str,
) -> Result<(), StateError> {
    let trusted = validate_whole_timestamp(trusted_at)?;
    let authenticated = validate_whole_timestamp(&authentication.authenticated_at)?;
    let cutoff = validate_derived_timestamp(cutoff_at)?;
    if trusted < cutoff {
        return Err(StateError::NotExpired);
    }
    let age = trusted - authenticated;
    if age.is_negative() {
        return Err(StateError::Future);
    }
    if age.whole_seconds() > 300 {
        return Err(StateError::Stale);
    }
    Ok(())
}

pub(crate) fn derive_candidate_close_challenge(
    previous_transition_sha256: &str,
    candidate_sha256: &str,
    approval_challenge_sha256: &str,
) -> Result<String, StateError> {
    derive_challenge(
        b"openspell.hosted-migration-close-candidate-challenge.v1\n",
        &[
            previous_transition_sha256,
            candidate_sha256,
            approval_challenge_sha256,
        ],
    )
}

pub(crate) fn derive_approval_close_challenge(
    previous_transition_sha256: &str,
    candidate_sha256: &str,
    approval_challenge_sha256: &str,
    grant_sha256: &str,
    grant_signature_sha256: &str,
) -> Result<String, StateError> {
    derive_challenge(
        b"openspell.hosted-migration-close-approval-challenge.v1\n",
        &[
            previous_transition_sha256,
            candidate_sha256,
            approval_challenge_sha256,
            grant_sha256,
            grant_signature_sha256,
        ],
    )
}

fn derive_challenge(domain: &[u8], digests: &[&str]) -> Result<String, StateError> {
    let mut preimage = Vec::with_capacity(domain.len() + digests.len() * 32);
    preimage.extend_from_slice(domain);
    for digest in digests {
        let decoded: [u8; 32] = hex::decode(digest)
            .map_err(|_| StateError::Canonical)?
            .try_into()
            .map_err(|_| StateError::Canonical)?;
        preimage.extend_from_slice(&decoded);
    }
    Ok(sha256_hex(&preimage))
}
