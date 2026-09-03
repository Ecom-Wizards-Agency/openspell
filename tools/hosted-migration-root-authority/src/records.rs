//! Private candidate, grant, ticket and transition records.

use serde::Deserialize;

use crate::canonical::{
    CanonicalError, FieldValue, MAX_CANONICAL_BYTES, decode_exact, is_lower_hex, object,
    validate_derived_timestamp, validate_millisecond_timestamp, validate_whole_timestamp,
};

pub(crate) const CANDIDATE_SCHEMA: &str = "openspell.hosted-migration-root-candidate.v1";
pub(crate) const GRANT_SCHEMA: &str = "openspell.hosted-migration-approval-grant.v1";
pub(crate) const TICKET_SCHEMA: &str = "openspell.hosted-migration-execution-ticket.v1";
pub(crate) const GRANT_DOMAIN: &str = "openspell.hosted-migration-approval-grant-signature.v1";
pub(crate) const TICKET_DOMAIN: &str = "openspell.hosted-migration-execution-ticket-signature.v1";
pub(crate) const GENESIS_SHA256: &str =
    "ca2d2cff450674f8748447a397c73c1f339c92b90dcaf4fccf6ad632a8f1eb8e";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Candidate {
    pub(crate) schema_version: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) target_fingerprint: String,
    pub(crate) target_selection_sha256: String,
    pub(crate) envelope_sha256: String,
    pub(crate) envelope_expires_at: String,
    pub(crate) external_exclusive_window_generation: u64,
    pub(crate) external_exclusive_window_evidence_sha256: String,
    pub(crate) external_exclusive_window_expires_at: String,
    pub(crate) official_source_evidence_sha256: String,
    pub(crate) native_runtime_identity_sha256: String,
    pub(crate) child_sandbox_policy_sha256: String,
    pub(crate) phase_exec_topology_policy_sha256: String,
    pub(crate) child_cgroup_policy_sha256: String,
    pub(crate) apply_invocation_evidence_sha256: String,
    pub(crate) operation_authority_incarnation_sha256: String,
    pub(crate) candidate_binding_sha256: String,
    pub(crate) approval_challenge_sha256: String,
    pub(crate) stored_at: String,
    pub(crate) cutoff_at: String,
}

impl Candidate {
    pub(crate) fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&[
            ("schemaVersion", FieldValue::String(&self.schema_version)),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            (
                "targetFingerprint",
                FieldValue::String(&self.target_fingerprint),
            ),
            (
                "targetSelectionSha256",
                FieldValue::String(&self.target_selection_sha256),
            ),
            ("envelopeSha256", FieldValue::String(&self.envelope_sha256)),
            (
                "envelopeExpiresAt",
                FieldValue::String(&self.envelope_expires_at),
            ),
            (
                "externalExclusiveWindowGeneration",
                FieldValue::Integer(self.external_exclusive_window_generation),
            ),
            (
                "externalExclusiveWindowEvidenceSha256",
                FieldValue::String(&self.external_exclusive_window_evidence_sha256),
            ),
            (
                "externalExclusiveWindowExpiresAt",
                FieldValue::String(&self.external_exclusive_window_expires_at),
            ),
            (
                "officialSourceEvidenceSha256",
                FieldValue::String(&self.official_source_evidence_sha256),
            ),
            (
                "nativeRuntimeIdentitySha256",
                FieldValue::String(&self.native_runtime_identity_sha256),
            ),
            (
                "childSandboxPolicySha256",
                FieldValue::String(&self.child_sandbox_policy_sha256),
            ),
            (
                "phaseExecTopologyPolicySha256",
                FieldValue::String(&self.phase_exec_topology_policy_sha256),
            ),
            (
                "childCgroupPolicySha256",
                FieldValue::String(&self.child_cgroup_policy_sha256),
            ),
            (
                "applyInvocationEvidenceSha256",
                FieldValue::String(&self.apply_invocation_evidence_sha256),
            ),
            (
                "operationAuthorityIncarnationSha256",
                FieldValue::String(&self.operation_authority_incarnation_sha256),
            ),
            (
                "candidateBindingSha256",
                FieldValue::String(&self.candidate_binding_sha256),
            ),
            (
                "approvalChallengeSha256",
                FieldValue::String(&self.approval_challenge_sha256),
            ),
            ("storedAt", FieldValue::String(&self.stored_at)),
            ("cutoffAt", FieldValue::String(&self.cutoff_at)),
        ])
    }

    pub(crate) fn encode_binding_projection(&self) -> Result<Vec<u8>, CanonicalError> {
        let fields = self.encode()?;
        let binding_line = format!(
            "  \"candidateBindingSha256\": \"{}\",\n",
            self.candidate_binding_sha256
        );
        let challenge_line = format!(
            "  \"approvalChallengeSha256\": \"{}\",\n",
            self.approval_challenge_sha256
        );
        let text = String::from_utf8(fields).map_err(|_| CanonicalError::Encoding)?;
        Ok(text
            .replacen(&binding_line, "", 1)
            .replacen(&challenge_line, "", 1)
            .into_bytes())
    }

    pub(crate) fn validate(&self) -> Result<(), CanonicalError> {
        if self.schema_version != CANDIDATE_SCHEMA
            || self.external_exclusive_window_generation == 0
            || !candidate_digests(self)
                .iter()
                .all(|value| is_lower_hex(value, 32))
        {
            return Err(CanonicalError::Decoding);
        }
        validate_whole_timestamp(&self.envelope_expires_at)?;
        validate_millisecond_timestamp(&self.external_exclusive_window_expires_at)?;
        validate_whole_timestamp(&self.stored_at)?;
        validate_derived_timestamp(&self.cutoff_at)?;
        Ok(())
    }

    pub(crate) fn decode(input: &[u8]) -> Result<Self, CanonicalError> {
        let candidate = decode_exact(input, Self::encode)?;
        candidate.validate()?;
        Ok(candidate)
    }
}

fn candidate_digests(candidate: &Candidate) -> [&str; 15] {
    [
        &candidate.operation_id,
        &candidate.authorization_nonce,
        &candidate.target_fingerprint,
        &candidate.target_selection_sha256,
        &candidate.envelope_sha256,
        &candidate.external_exclusive_window_evidence_sha256,
        &candidate.official_source_evidence_sha256,
        &candidate.native_runtime_identity_sha256,
        &candidate.child_sandbox_policy_sha256,
        &candidate.phase_exec_topology_policy_sha256,
        &candidate.child_cgroup_policy_sha256,
        &candidate.apply_invocation_evidence_sha256,
        &candidate.operation_authority_incarnation_sha256,
        &candidate.candidate_binding_sha256,
        &candidate.approval_challenge_sha256,
    ]
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalGrant {
    pub(crate) schema_version: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) target_fingerprint: String,
    pub(crate) target_selection_sha256: String,
    pub(crate) envelope_sha256: String,
    pub(crate) external_exclusive_window_generation: u64,
    pub(crate) external_exclusive_window_evidence_sha256: String,
    pub(crate) official_source_evidence_sha256: String,
    pub(crate) native_runtime_identity_sha256: String,
    pub(crate) child_sandbox_policy_sha256: String,
    pub(crate) phase_exec_topology_policy_sha256: String,
    pub(crate) child_cgroup_policy_sha256: String,
    pub(crate) apply_invocation_evidence_sha256: String,
    pub(crate) issued_at: String,
    pub(crate) expires_at: String,
    pub(crate) authenticated_operator_identity_sha256: String,
    pub(crate) os_authentication_session_sha256: String,
    pub(crate) authenticated_at: String,
    pub(crate) state: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

impl ApprovalGrant {
    pub(crate) fn encode_unsigned(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&self.fields(false))
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&self.fields(true))
    }

    fn fields(&self, signed: bool) -> Vec<(&str, FieldValue<'_>)> {
        let mut fields = vec![
            ("schemaVersion", FieldValue::String(&self.schema_version)),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            (
                "targetFingerprint",
                FieldValue::String(&self.target_fingerprint),
            ),
            (
                "targetSelectionSha256",
                FieldValue::String(&self.target_selection_sha256),
            ),
            ("envelopeSha256", FieldValue::String(&self.envelope_sha256)),
            (
                "externalExclusiveWindowGeneration",
                FieldValue::Integer(self.external_exclusive_window_generation),
            ),
            (
                "externalExclusiveWindowEvidenceSha256",
                FieldValue::String(&self.external_exclusive_window_evidence_sha256),
            ),
            (
                "officialSourceEvidenceSha256",
                FieldValue::String(&self.official_source_evidence_sha256),
            ),
            (
                "nativeRuntimeIdentitySha256",
                FieldValue::String(&self.native_runtime_identity_sha256),
            ),
            (
                "childSandboxPolicySha256",
                FieldValue::String(&self.child_sandbox_policy_sha256),
            ),
            (
                "phaseExecTopologyPolicySha256",
                FieldValue::String(&self.phase_exec_topology_policy_sha256),
            ),
            (
                "childCgroupPolicySha256",
                FieldValue::String(&self.child_cgroup_policy_sha256),
            ),
            (
                "applyInvocationEvidenceSha256",
                FieldValue::String(&self.apply_invocation_evidence_sha256),
            ),
            ("issuedAt", FieldValue::String(&self.issued_at)),
            ("expiresAt", FieldValue::String(&self.expires_at)),
            (
                "authenticatedOperatorIdentitySha256",
                FieldValue::String(&self.authenticated_operator_identity_sha256),
            ),
            (
                "osAuthenticationSessionSha256",
                FieldValue::String(&self.os_authentication_session_sha256),
            ),
            (
                "authenticatedAt",
                FieldValue::String(&self.authenticated_at),
            ),
            ("state", FieldValue::String(&self.state)),
            (
                "issuerPublicKeySha256",
                FieldValue::String(&self.issuer_public_key_sha256),
            ),
        ];
        if signed {
            fields.push((
                "detachedSignatureSha256",
                FieldValue::String(&self.detached_signature_sha256),
            ));
        }
        fields
    }

    pub(crate) fn validate(&self) -> Result<(), CanonicalError> {
        if self.schema_version != GRANT_SCHEMA
            || self.state != "approved"
            || self.external_exclusive_window_generation == 0
            || !grant_digests(self)
                .iter()
                .all(|value| is_lower_hex(value, 32))
        {
            return Err(CanonicalError::Decoding);
        }
        let issued = validate_whole_timestamp(&self.issued_at)?;
        let expires = validate_derived_timestamp(&self.expires_at)?;
        let authenticated = validate_whole_timestamp(&self.authenticated_at)?;
        let authentication_age = issued - authenticated;
        if expires <= issued
            || authentication_age.is_negative()
            || authentication_age.whole_seconds() > 300
            || expires - issued > time::Duration::minutes(15)
        {
            return Err(CanonicalError::Timestamp);
        }
        Ok(())
    }

    pub(crate) fn decode(input: &[u8]) -> Result<Self, CanonicalError> {
        let grant = decode_exact(input, Self::encode)?;
        grant.validate()?;
        Ok(grant)
    }
}

fn grant_digests(grant: &ApprovalGrant) -> [&str; 16] {
    [
        &grant.operation_id,
        &grant.authorization_nonce,
        &grant.target_fingerprint,
        &grant.target_selection_sha256,
        &grant.envelope_sha256,
        &grant.external_exclusive_window_evidence_sha256,
        &grant.official_source_evidence_sha256,
        &grant.native_runtime_identity_sha256,
        &grant.child_sandbox_policy_sha256,
        &grant.phase_exec_topology_policy_sha256,
        &grant.child_cgroup_policy_sha256,
        &grant.apply_invocation_evidence_sha256,
        &grant.authenticated_operator_identity_sha256,
        &grant.os_authentication_session_sha256,
        &grant.issuer_public_key_sha256,
        &grant.detached_signature_sha256,
    ]
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionTicket {
    pub(crate) schema_version: String,
    pub(crate) approval_grant_sha256: String,
    pub(crate) approval_grant_signature_sha256: String,
    pub(crate) ticket_nonce: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) target_fingerprint: String,
    pub(crate) target_selection_sha256: String,
    pub(crate) envelope_sha256: String,
    pub(crate) external_exclusive_window_generation: u64,
    pub(crate) external_exclusive_window_evidence_sha256: String,
    pub(crate) official_source_evidence_sha256: String,
    pub(crate) native_runtime_identity_sha256: String,
    pub(crate) child_sandbox_policy_sha256: String,
    pub(crate) phase_exec_topology_policy_sha256: String,
    pub(crate) child_cgroup_policy_sha256: String,
    pub(crate) apply_invocation_evidence_sha256: String,
    pub(crate) consumed_at: String,
    pub(crate) expires_at: String,
    pub(crate) state: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

impl ExecutionTicket {
    pub(crate) fn encode_unsigned(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&self.fields(false))
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&self.fields(true))
    }

    fn fields(&self, signed: bool) -> Vec<(&str, FieldValue<'_>)> {
        let mut fields = vec![
            ("schemaVersion", FieldValue::String(&self.schema_version)),
            (
                "approvalGrantSha256",
                FieldValue::String(&self.approval_grant_sha256),
            ),
            (
                "approvalGrantSignatureSha256",
                FieldValue::String(&self.approval_grant_signature_sha256),
            ),
            ("ticketNonce", FieldValue::String(&self.ticket_nonce)),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            (
                "targetFingerprint",
                FieldValue::String(&self.target_fingerprint),
            ),
            (
                "targetSelectionSha256",
                FieldValue::String(&self.target_selection_sha256),
            ),
            ("envelopeSha256", FieldValue::String(&self.envelope_sha256)),
            (
                "externalExclusiveWindowGeneration",
                FieldValue::Integer(self.external_exclusive_window_generation),
            ),
            (
                "externalExclusiveWindowEvidenceSha256",
                FieldValue::String(&self.external_exclusive_window_evidence_sha256),
            ),
            (
                "officialSourceEvidenceSha256",
                FieldValue::String(&self.official_source_evidence_sha256),
            ),
            (
                "nativeRuntimeIdentitySha256",
                FieldValue::String(&self.native_runtime_identity_sha256),
            ),
            (
                "childSandboxPolicySha256",
                FieldValue::String(&self.child_sandbox_policy_sha256),
            ),
            (
                "phaseExecTopologyPolicySha256",
                FieldValue::String(&self.phase_exec_topology_policy_sha256),
            ),
            (
                "childCgroupPolicySha256",
                FieldValue::String(&self.child_cgroup_policy_sha256),
            ),
            (
                "applyInvocationEvidenceSha256",
                FieldValue::String(&self.apply_invocation_evidence_sha256),
            ),
            ("consumedAt", FieldValue::String(&self.consumed_at)),
            ("expiresAt", FieldValue::String(&self.expires_at)),
            ("state", FieldValue::String(&self.state)),
            (
                "issuerPublicKeySha256",
                FieldValue::String(&self.issuer_public_key_sha256),
            ),
        ];
        if signed {
            fields.push((
                "detachedSignatureSha256",
                FieldValue::String(&self.detached_signature_sha256),
            ));
        }
        fields
    }

    pub(crate) fn validate(&self) -> Result<(), CanonicalError> {
        if self.schema_version != TICKET_SCHEMA
            || self.state != "consumed"
            || self.external_exclusive_window_generation == 0
            || !ticket_digests(self)
                .iter()
                .all(|value| is_lower_hex(value, 32))
        {
            return Err(CanonicalError::Decoding);
        }
        let consumed = validate_whole_timestamp(&self.consumed_at)?;
        let expires = validate_derived_timestamp(&self.expires_at)?;
        if expires <= consumed {
            return Err(CanonicalError::Timestamp);
        }
        Ok(())
    }

    pub(crate) fn decode(input: &[u8]) -> Result<Self, CanonicalError> {
        let ticket = decode_exact(input, Self::encode)?;
        ticket.validate()?;
        Ok(ticket)
    }
}

fn ticket_digests(ticket: &ExecutionTicket) -> [&str; 17] {
    [
        &ticket.approval_grant_sha256,
        &ticket.approval_grant_signature_sha256,
        &ticket.ticket_nonce,
        &ticket.operation_id,
        &ticket.authorization_nonce,
        &ticket.target_fingerprint,
        &ticket.target_selection_sha256,
        &ticket.envelope_sha256,
        &ticket.external_exclusive_window_evidence_sha256,
        &ticket.official_source_evidence_sha256,
        &ticket.native_runtime_identity_sha256,
        &ticket.child_sandbox_policy_sha256,
        &ticket.phase_exec_topology_policy_sha256,
        &ticket.child_cgroup_policy_sha256,
        &ticket.apply_invocation_evidence_sha256,
        &ticket.issuer_public_key_sha256,
        &ticket.detached_signature_sha256,
    ]
}

pub(crate) const CANDIDATE_REGISTERED_SCHEMA: &str =
    "openspell.hosted-migration-root-candidate-registered.v1";
pub(crate) const APPROVED_SCHEMA: &str = "openspell.hosted-migration-root-approved.v1";
pub(crate) const CONSUMED_SCHEMA: &str = "openspell.hosted-migration-root-consumed.v1";
pub(crate) const CANDIDATE_EXPIRED_SCHEMA: &str =
    "openspell.hosted-migration-root-candidate-expired.v1";
pub(crate) const APPROVAL_EXPIRED_SCHEMA: &str =
    "openspell.hosted-migration-root-approval-expired.v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateRegisteredTransition {
    pub(crate) schema_version: String,
    pub(crate) generation: u64,
    pub(crate) previous_transition_sha256: String,
    pub(crate) transition_kind: String,
    pub(crate) prior_state: String,
    pub(crate) resulting_state: String,
    pub(crate) candidate_sha256: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) envelope_sha256: String,
    pub(crate) operation_authority_incarnation_sha256: String,
    pub(crate) candidate_binding_sha256: String,
    pub(crate) approval_challenge_sha256: String,
    pub(crate) trusted_at: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovedTransition {
    pub(crate) schema_version: String,
    pub(crate) generation: u64,
    pub(crate) previous_transition_sha256: String,
    pub(crate) transition_kind: String,
    pub(crate) prior_state: String,
    pub(crate) resulting_state: String,
    pub(crate) candidate_sha256: String,
    pub(crate) approval_grant_sha256: String,
    pub(crate) approval_grant_signature_sha256: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) envelope_sha256: String,
    pub(crate) operation_authority_incarnation_sha256: String,
    pub(crate) trusted_at: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumedTransition {
    pub(crate) schema_version: String,
    pub(crate) generation: u64,
    pub(crate) previous_transition_sha256: String,
    pub(crate) transition_kind: String,
    pub(crate) prior_state: String,
    pub(crate) resulting_state: String,
    pub(crate) candidate_sha256: String,
    pub(crate) approval_grant_sha256: String,
    pub(crate) approval_grant_signature_sha256: String,
    pub(crate) execution_ticket_sha256: String,
    pub(crate) execution_ticket_signature_sha256: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) envelope_sha256: String,
    pub(crate) operation_authority_incarnation_sha256: String,
    pub(crate) trusted_at: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CandidateExpiredTransition {
    pub(crate) schema_version: String,
    pub(crate) generation: u64,
    pub(crate) previous_transition_sha256: String,
    pub(crate) transition_kind: String,
    pub(crate) prior_state: String,
    pub(crate) resulting_state: String,
    pub(crate) candidate_sha256: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) envelope_sha256: String,
    pub(crate) operation_authority_incarnation_sha256: String,
    pub(crate) closing_authority_incarnation_sha256: String,
    pub(crate) action_challenge_sha256: String,
    pub(crate) authenticated_operator_identity_sha256: String,
    pub(crate) os_authentication_session_sha256: String,
    pub(crate) authenticated_at: String,
    pub(crate) cutoff_at: String,
    pub(crate) trusted_at: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalExpiredTransition {
    pub(crate) schema_version: String,
    pub(crate) generation: u64,
    pub(crate) previous_transition_sha256: String,
    pub(crate) transition_kind: String,
    pub(crate) prior_state: String,
    pub(crate) resulting_state: String,
    pub(crate) candidate_sha256: String,
    pub(crate) approval_grant_sha256: String,
    pub(crate) approval_grant_signature_sha256: String,
    pub(crate) operation_id: String,
    pub(crate) authorization_nonce: String,
    pub(crate) envelope_sha256: String,
    pub(crate) operation_authority_incarnation_sha256: String,
    pub(crate) closing_authority_incarnation_sha256: String,
    pub(crate) action_challenge_sha256: String,
    pub(crate) authenticated_operator_identity_sha256: String,
    pub(crate) os_authentication_session_sha256: String,
    pub(crate) authenticated_at: String,
    pub(crate) cutoff_at: String,
    pub(crate) trusted_at: String,
    pub(crate) issuer_public_key_sha256: String,
    pub(crate) detached_signature_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Transition {
    CandidateRegistered(CandidateRegisteredTransition),
    Approved(ApprovedTransition),
    Consumed(ConsumedTransition),
    CandidateExpired(CandidateExpiredTransition),
    ApprovalExpired(ApprovalExpiredTransition),
}

impl Transition {
    pub(crate) fn schema_version(&self) -> &str {
        match self {
            Self::CandidateRegistered(value) => &value.schema_version,
            Self::Approved(value) => &value.schema_version,
            Self::Consumed(value) => &value.schema_version,
            Self::CandidateExpired(value) => &value.schema_version,
            Self::ApprovalExpired(value) => &value.schema_version,
        }
    }

    pub(crate) fn generation(&self) -> u64 {
        match self {
            Self::CandidateRegistered(value) => value.generation,
            Self::Approved(value) => value.generation,
            Self::Consumed(value) => value.generation,
            Self::CandidateExpired(value) => value.generation,
            Self::ApprovalExpired(value) => value.generation,
        }
    }

    pub(crate) fn previous_transition_sha256(&self) -> &str {
        match self {
            Self::CandidateRegistered(value) => &value.previous_transition_sha256,
            Self::Approved(value) => &value.previous_transition_sha256,
            Self::Consumed(value) => &value.previous_transition_sha256,
            Self::CandidateExpired(value) => &value.previous_transition_sha256,
            Self::ApprovalExpired(value) => &value.previous_transition_sha256,
        }
    }

    pub(crate) fn trusted_at(&self) -> &str {
        match self {
            Self::CandidateRegistered(value) => &value.trusted_at,
            Self::Approved(value) => &value.trusted_at,
            Self::Consumed(value) => &value.trusted_at,
            Self::CandidateExpired(value) => &value.trusted_at,
            Self::ApprovalExpired(value) => &value.trusted_at,
        }
    }

    pub(crate) fn issuer_public_key_sha256(&self) -> &str {
        match self {
            Self::CandidateRegistered(value) => &value.issuer_public_key_sha256,
            Self::Approved(value) => &value.issuer_public_key_sha256,
            Self::Consumed(value) => &value.issuer_public_key_sha256,
            Self::CandidateExpired(value) => &value.issuer_public_key_sha256,
            Self::ApprovalExpired(value) => &value.issuer_public_key_sha256,
        }
    }

    pub(crate) fn detached_signature_sha256(&self) -> &str {
        match self {
            Self::CandidateRegistered(value) => &value.detached_signature_sha256,
            Self::Approved(value) => &value.detached_signature_sha256,
            Self::Consumed(value) => &value.detached_signature_sha256,
            Self::CandidateExpired(value) => &value.detached_signature_sha256,
            Self::ApprovalExpired(value) => &value.detached_signature_sha256,
        }
    }

    pub(crate) fn domain(&self) -> &'static str {
        match self {
            Self::CandidateRegistered(_) => {
                "openspell.hosted-migration-root-candidate-registered-signature.v1"
            }
            Self::Approved(_) => "openspell.hosted-migration-root-approved-signature.v1",
            Self::Consumed(_) => "openspell.hosted-migration-root-consumed-signature.v1",
            Self::CandidateExpired(_) => {
                "openspell.hosted-migration-root-candidate-expired-signature.v1"
            }
            Self::ApprovalExpired(_) => {
                "openspell.hosted-migration-root-approval-expired-signature.v1"
            }
        }
    }

    pub(crate) fn encode_unsigned(&self) -> Result<Vec<u8>, CanonicalError> {
        match self {
            Self::CandidateRegistered(value) => value.encode(false),
            Self::Approved(value) => value.encode(false),
            Self::Consumed(value) => value.encode(false),
            Self::CandidateExpired(value) => value.encode(false),
            Self::ApprovalExpired(value) => value.encode(false),
        }
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        match self {
            Self::CandidateRegistered(value) => value.encode(true),
            Self::Approved(value) => value.encode(true),
            Self::Consumed(value) => value.encode(true),
            Self::CandidateExpired(value) => value.encode(true),
            Self::ApprovalExpired(value) => value.encode(true),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), CanonicalError> {
        match self {
            Self::CandidateRegistered(value) => value.validate(),
            Self::Approved(value) => value.validate(),
            Self::Consumed(value) => value.validate(),
            Self::CandidateExpired(value) => value.validate(),
            Self::ApprovalExpired(value) => value.validate(),
        }
    }

    pub(crate) fn decode(input: &[u8]) -> Result<Self, CanonicalError> {
        if input.is_empty() || input.len() > MAX_CANONICAL_BYTES {
            return Err(CanonicalError::Limit);
        }
        const PREFIX: &[u8] = b"{\n  \"schemaVersion\": \"";
        if !input.starts_with(PREFIX) {
            return Err(CanonicalError::Decoding);
        }
        let tail = &input[PREFIX.len()..];
        let schema_end = tail
            .iter()
            .position(|byte| *byte == b'\"')
            .ok_or(CanonicalError::Decoding)?;
        let schema =
            std::str::from_utf8(&tail[..schema_end]).map_err(|_| CanonicalError::Decoding)?;
        let transition = match schema {
            CANDIDATE_REGISTERED_SCHEMA => {
                Self::CandidateRegistered(decode_exact(input, |value| {
                    CandidateRegisteredTransition::encode(value, true)
                })?)
            }
            APPROVED_SCHEMA => Self::Approved(decode_exact(input, |value| {
                ApprovedTransition::encode(value, true)
            })?),
            CONSUMED_SCHEMA => Self::Consumed(decode_exact(input, |value| {
                ConsumedTransition::encode(value, true)
            })?),
            CANDIDATE_EXPIRED_SCHEMA => Self::CandidateExpired(decode_exact(input, |value| {
                CandidateExpiredTransition::encode(value, true)
            })?),
            APPROVAL_EXPIRED_SCHEMA => Self::ApprovalExpired(decode_exact(input, |value| {
                ApprovalExpiredTransition::encode(value, true)
            })?),
            _ => return Err(CanonicalError::Decoding),
        };
        transition.validate()?;
        Ok(transition)
    }
}

fn transition_fields<'a>(
    schema: &'a str,
    generation: u64,
    previous: &'a str,
    kind: &'a str,
    prior: &'a str,
    resulting: &'a str,
) -> Vec<(&'a str, FieldValue<'a>)> {
    vec![
        ("schemaVersion", FieldValue::String(schema)),
        ("generation", FieldValue::Integer(generation)),
        ("previousTransitionSha256", FieldValue::String(previous)),
        ("transitionKind", FieldValue::String(kind)),
        ("priorState", FieldValue::String(prior)),
        ("resultingState", FieldValue::String(resulting)),
    ]
}

fn finish_transition<'a>(
    fields: &mut Vec<(&'a str, FieldValue<'a>)>,
    issuer: &'a str,
    detached: &'a str,
    signed: bool,
) -> Result<Vec<u8>, CanonicalError> {
    fields.push(("issuerPublicKeySha256", FieldValue::String(issuer)));
    if signed {
        fields.push(("detachedSignatureSha256", FieldValue::String(detached)));
    }
    object(fields)
}

impl CandidateRegisteredTransition {
    fn encode(&self, signed: bool) -> Result<Vec<u8>, CanonicalError> {
        let mut fields = transition_fields(
            &self.schema_version,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            &self.prior_state,
            &self.resulting_state,
        );
        fields.extend([
            (
                "candidateSha256",
                FieldValue::String(&self.candidate_sha256),
            ),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            ("envelopeSha256", FieldValue::String(&self.envelope_sha256)),
            (
                "operationAuthorityIncarnationSha256",
                FieldValue::String(&self.operation_authority_incarnation_sha256),
            ),
            (
                "candidateBindingSha256",
                FieldValue::String(&self.candidate_binding_sha256),
            ),
            (
                "approvalChallengeSha256",
                FieldValue::String(&self.approval_challenge_sha256),
            ),
            ("trustedAt", FieldValue::String(&self.trusted_at)),
        ]);
        finish_transition(
            &mut fields,
            &self.issuer_public_key_sha256,
            &self.detached_signature_sha256,
            signed,
        )
    }

    fn validate(&self) -> Result<(), CanonicalError> {
        validate_transition_common(
            &self.schema_version,
            CANDIDATE_REGISTERED_SCHEMA,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            "candidate_registered",
            (self.prior_state == "empty"
                && self.generation == 1
                && self.previous_transition_sha256 == GENESIS_SHA256)
                || (["candidate_expired", "approval_expired"].contains(&self.prior_state.as_str())
                    && self.generation >= 3),
            &self.resulting_state,
            "candidate_registered",
            &[
                &self.candidate_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.operation_authority_incarnation_sha256,
                &self.candidate_binding_sha256,
                &self.approval_challenge_sha256,
                &self.issuer_public_key_sha256,
                &self.detached_signature_sha256,
            ],
            &self.trusted_at,
        )
    }
}

impl ApprovedTransition {
    fn encode(&self, signed: bool) -> Result<Vec<u8>, CanonicalError> {
        let mut fields = transition_fields(
            &self.schema_version,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            &self.prior_state,
            &self.resulting_state,
        );
        fields.extend([
            (
                "candidateSha256",
                FieldValue::String(&self.candidate_sha256),
            ),
            (
                "approvalGrantSha256",
                FieldValue::String(&self.approval_grant_sha256),
            ),
            (
                "approvalGrantSignatureSha256",
                FieldValue::String(&self.approval_grant_signature_sha256),
            ),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            ("envelopeSha256", FieldValue::String(&self.envelope_sha256)),
            (
                "operationAuthorityIncarnationSha256",
                FieldValue::String(&self.operation_authority_incarnation_sha256),
            ),
            ("trustedAt", FieldValue::String(&self.trusted_at)),
        ]);
        finish_transition(
            &mut fields,
            &self.issuer_public_key_sha256,
            &self.detached_signature_sha256,
            signed,
        )
    }

    fn validate(&self) -> Result<(), CanonicalError> {
        validate_transition_common(
            &self.schema_version,
            APPROVED_SCHEMA,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            "approved",
            self.prior_state == "candidate_registered" && self.generation >= 2,
            &self.resulting_state,
            "approved",
            &[
                &self.candidate_sha256,
                &self.approval_grant_sha256,
                &self.approval_grant_signature_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.operation_authority_incarnation_sha256,
                &self.issuer_public_key_sha256,
                &self.detached_signature_sha256,
            ],
            &self.trusted_at,
        )
    }
}

impl ConsumedTransition {
    fn encode(&self, signed: bool) -> Result<Vec<u8>, CanonicalError> {
        let mut fields = transition_fields(
            &self.schema_version,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            &self.prior_state,
            &self.resulting_state,
        );
        fields.extend([
            (
                "candidateSha256",
                FieldValue::String(&self.candidate_sha256),
            ),
            (
                "approvalGrantSha256",
                FieldValue::String(&self.approval_grant_sha256),
            ),
            (
                "approvalGrantSignatureSha256",
                FieldValue::String(&self.approval_grant_signature_sha256),
            ),
            (
                "executionTicketSha256",
                FieldValue::String(&self.execution_ticket_sha256),
            ),
            (
                "executionTicketSignatureSha256",
                FieldValue::String(&self.execution_ticket_signature_sha256),
            ),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            ("envelopeSha256", FieldValue::String(&self.envelope_sha256)),
            (
                "operationAuthorityIncarnationSha256",
                FieldValue::String(&self.operation_authority_incarnation_sha256),
            ),
            ("trustedAt", FieldValue::String(&self.trusted_at)),
        ]);
        finish_transition(
            &mut fields,
            &self.issuer_public_key_sha256,
            &self.detached_signature_sha256,
            signed,
        )
    }

    fn validate(&self) -> Result<(), CanonicalError> {
        validate_transition_common(
            &self.schema_version,
            CONSUMED_SCHEMA,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            "consumed",
            self.prior_state == "approved" && self.generation >= 3,
            &self.resulting_state,
            "consumed",
            &[
                &self.candidate_sha256,
                &self.approval_grant_sha256,
                &self.approval_grant_signature_sha256,
                &self.execution_ticket_sha256,
                &self.execution_ticket_signature_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.operation_authority_incarnation_sha256,
                &self.issuer_public_key_sha256,
                &self.detached_signature_sha256,
            ],
            &self.trusted_at,
        )
    }
}

struct ClosureFields<'a> {
    operation_id: &'a str,
    authorization_nonce: &'a str,
    envelope_sha256: &'a str,
    operation_incarnation: &'a str,
    closing_incarnation: &'a str,
    action_challenge: &'a str,
    operator_identity: &'a str,
    session: &'a str,
    authenticated_at: &'a str,
    cutoff_at: &'a str,
    trusted_at: &'a str,
}

fn closure_fields<'a>(fields: &mut Vec<(&'a str, FieldValue<'a>)>, closure: ClosureFields<'a>) {
    fields.extend([
        ("operationId", FieldValue::String(closure.operation_id)),
        (
            "authorizationNonce",
            FieldValue::String(closure.authorization_nonce),
        ),
        (
            "envelopeSha256",
            FieldValue::String(closure.envelope_sha256),
        ),
        (
            "operationAuthorityIncarnationSha256",
            FieldValue::String(closure.operation_incarnation),
        ),
        (
            "closingAuthorityIncarnationSha256",
            FieldValue::String(closure.closing_incarnation),
        ),
        (
            "actionChallengeSha256",
            FieldValue::String(closure.action_challenge),
        ),
        (
            "authenticatedOperatorIdentitySha256",
            FieldValue::String(closure.operator_identity),
        ),
        (
            "osAuthenticationSessionSha256",
            FieldValue::String(closure.session),
        ),
        (
            "authenticatedAt",
            FieldValue::String(closure.authenticated_at),
        ),
        ("cutoffAt", FieldValue::String(closure.cutoff_at)),
        ("trustedAt", FieldValue::String(closure.trusted_at)),
    ]);
}

impl CandidateExpiredTransition {
    fn encode(&self, signed: bool) -> Result<Vec<u8>, CanonicalError> {
        let mut fields = transition_fields(
            &self.schema_version,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            &self.prior_state,
            &self.resulting_state,
        );
        fields.push((
            "candidateSha256",
            FieldValue::String(&self.candidate_sha256),
        ));
        closure_fields(
            &mut fields,
            ClosureFields {
                operation_id: &self.operation_id,
                authorization_nonce: &self.authorization_nonce,
                envelope_sha256: &self.envelope_sha256,
                operation_incarnation: &self.operation_authority_incarnation_sha256,
                closing_incarnation: &self.closing_authority_incarnation_sha256,
                action_challenge: &self.action_challenge_sha256,
                operator_identity: &self.authenticated_operator_identity_sha256,
                session: &self.os_authentication_session_sha256,
                authenticated_at: &self.authenticated_at,
                cutoff_at: &self.cutoff_at,
                trusted_at: &self.trusted_at,
            },
        );
        finish_transition(
            &mut fields,
            &self.issuer_public_key_sha256,
            &self.detached_signature_sha256,
            signed,
        )
    }

    fn validate(&self) -> Result<(), CanonicalError> {
        validate_closure(
            &self.schema_version,
            CANDIDATE_EXPIRED_SCHEMA,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            "candidate_expired",
            &self.prior_state,
            "candidate_registered",
            &self.resulting_state,
            "candidate_expired",
            &[
                &self.candidate_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.operation_authority_incarnation_sha256,
                &self.closing_authority_incarnation_sha256,
                &self.action_challenge_sha256,
                &self.authenticated_operator_identity_sha256,
                &self.os_authentication_session_sha256,
                &self.issuer_public_key_sha256,
                &self.detached_signature_sha256,
            ],
            &self.authenticated_at,
            &self.cutoff_at,
            &self.trusted_at,
            self.generation >= 2,
        )
    }
}

impl ApprovalExpiredTransition {
    fn encode(&self, signed: bool) -> Result<Vec<u8>, CanonicalError> {
        let mut fields = transition_fields(
            &self.schema_version,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            &self.prior_state,
            &self.resulting_state,
        );
        fields.extend([
            (
                "candidateSha256",
                FieldValue::String(&self.candidate_sha256),
            ),
            (
                "approvalGrantSha256",
                FieldValue::String(&self.approval_grant_sha256),
            ),
            (
                "approvalGrantSignatureSha256",
                FieldValue::String(&self.approval_grant_signature_sha256),
            ),
        ]);
        closure_fields(
            &mut fields,
            ClosureFields {
                operation_id: &self.operation_id,
                authorization_nonce: &self.authorization_nonce,
                envelope_sha256: &self.envelope_sha256,
                operation_incarnation: &self.operation_authority_incarnation_sha256,
                closing_incarnation: &self.closing_authority_incarnation_sha256,
                action_challenge: &self.action_challenge_sha256,
                operator_identity: &self.authenticated_operator_identity_sha256,
                session: &self.os_authentication_session_sha256,
                authenticated_at: &self.authenticated_at,
                cutoff_at: &self.cutoff_at,
                trusted_at: &self.trusted_at,
            },
        );
        finish_transition(
            &mut fields,
            &self.issuer_public_key_sha256,
            &self.detached_signature_sha256,
            signed,
        )
    }

    fn validate(&self) -> Result<(), CanonicalError> {
        validate_closure(
            &self.schema_version,
            APPROVAL_EXPIRED_SCHEMA,
            self.generation,
            &self.previous_transition_sha256,
            &self.transition_kind,
            "approval_expired",
            &self.prior_state,
            "approved",
            &self.resulting_state,
            "approval_expired",
            &[
                &self.candidate_sha256,
                &self.approval_grant_sha256,
                &self.approval_grant_signature_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.operation_authority_incarnation_sha256,
                &self.closing_authority_incarnation_sha256,
                &self.action_challenge_sha256,
                &self.authenticated_operator_identity_sha256,
                &self.os_authentication_session_sha256,
                &self.issuer_public_key_sha256,
                &self.detached_signature_sha256,
            ],
            &self.authenticated_at,
            &self.cutoff_at,
            &self.trusted_at,
            self.generation >= 3,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_transition_common(
    schema: &str,
    expected_schema: &str,
    generation: u64,
    previous: &str,
    kind: &str,
    expected_kind: &str,
    prior_valid: bool,
    resulting: &str,
    expected_resulting: &str,
    digests: &[&String],
    trusted_at: &str,
) -> Result<(), CanonicalError> {
    if schema != expected_schema
        || generation == 0
        || generation > 9_999_999_999
        || kind != expected_kind
        || !prior_valid
        || resulting != expected_resulting
        || !is_lower_hex(previous, 32)
        || !digests.iter().all(|value| is_lower_hex(value, 32))
    {
        return Err(CanonicalError::Decoding);
    }
    validate_whole_timestamp(trusted_at)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_closure(
    schema: &str,
    expected_schema: &str,
    generation: u64,
    previous: &str,
    kind: &str,
    expected_kind: &str,
    prior: &str,
    expected_prior: &str,
    resulting: &str,
    expected_resulting: &str,
    digests: &[&String],
    authenticated_at: &str,
    cutoff_at: &str,
    trusted_at: &str,
    generation_valid: bool,
) -> Result<(), CanonicalError> {
    validate_transition_common(
        schema,
        expected_schema,
        generation,
        previous,
        kind,
        expected_kind,
        prior == expected_prior && generation_valid,
        resulting,
        expected_resulting,
        digests,
        trusted_at,
    )?;
    let authenticated = validate_whole_timestamp(authenticated_at)?;
    let cutoff = validate_derived_timestamp(cutoff_at)?;
    let trusted = validate_whole_timestamp(trusted_at)?;
    if authenticated > trusted
        || (trusted - authenticated).whole_seconds() > 300
        || trusted < cutoff
    {
        return Err(CanonicalError::Timestamp);
    }
    Ok(())
}
