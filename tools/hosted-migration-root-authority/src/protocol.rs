//! Fixed supervisor and attended-operator protocol codecs.

use serde::Deserialize;

use crate::canonical::{
    CanonicalError, FieldValue, decode_exact, is_lower_hex, object, validate_millisecond_timestamp,
    validate_whole_timestamp,
};
use crate::crypto::sha256;
use crate::crypto::sha256_hex;
use crate::journal::storage::{
    ApproveCommand, CloseApprovalCommand, CloseCandidateCommand, ConsumeCommand, HeadCas,
    RegisterCommand, StatusCommand,
};
use crate::journal::{DurableSuccess, VerifiedStatus};
use crate::records::{CANDIDATE_SCHEMA, Candidate, ExecutionTicket};

pub(crate) const FRAME_VERSION: u16 = 1;
pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024;
pub(crate) const FRAME_HEADER_BYTES: usize = 48;
const MAGIC: &[u8; 8] = b"OSWP199\0";

pub(crate) const SUPERVISOR_REGISTER: u16 = 0x1101;
pub(crate) const SUPERVISOR_STATUS: u16 = 0x1102;
pub(crate) const SUPERVISOR_CONSUME: u16 = 0x1103;
pub(crate) const OPERATOR_APPROVE: u16 = 0x2101;
pub(crate) const OPERATOR_CLOSE_CANDIDATE: u16 = 0x2102;
pub(crate) const OPERATOR_CLOSE_APPROVAL: u16 = 0x2103;
pub(crate) const SUPERVISOR_REGISTER_SUCCESS: u16 = 0x9101;
pub(crate) const SUPERVISOR_STATUS_SUCCESS: u16 = 0x9102;
pub(crate) const SUPERVISOR_CONSUME_SUCCESS: u16 = 0x9103;
pub(crate) const OPERATOR_APPROVE_SUCCESS: u16 = 0xa101;
pub(crate) const OPERATOR_CLOSE_CANDIDATE_SUCCESS: u16 = 0xa102;
pub(crate) const OPERATOR_CLOSE_APPROVAL_SUCCESS: u16 = 0xa103;
pub(crate) const SUPERVISOR_REFUSAL: u16 = 0x9fff;
pub(crate) const OPERATOR_REFUSAL: u16 = 0xafff;

const MAX_GENERATION: u64 = 9_999_999_999;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProtocolError {
    Frame,
    Limit,
    MessageType,
    Payload,
}

impl From<CanonicalError> for ProtocolError {
    fn from(error: CanonicalError) -> Self {
        match error {
            CanonicalError::Limit => Self::Limit,
            _ => Self::Payload,
        }
    }
}

struct ParsedFrame<'a> {
    message_type: u16,
    payload: &'a [u8],
}

fn parse_frame(input: &[u8]) -> Result<ParsedFrame<'_>, ProtocolError> {
    if input.len() < FRAME_HEADER_BYTES || input.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::Limit);
    }
    if &input[..8] != MAGIC {
        return Err(ProtocolError::Frame);
    }
    let version = u16::from_be_bytes([input[8], input[9]]);
    if version != FRAME_VERSION {
        return Err(ProtocolError::Frame);
    }
    let message_type = u16::from_be_bytes([input[10], input[11]]);
    let payload_length = u32::from_be_bytes([input[12], input[13], input[14], input[15]]) as usize;
    if payload_length != input.len() - FRAME_HEADER_BYTES {
        return Err(ProtocolError::Frame);
    }
    let payload = &input[FRAME_HEADER_BYTES..];
    if input[16..FRAME_HEADER_BYTES] != sha256(payload) {
        return Err(ProtocolError::Frame);
    }
    Ok(ParsedFrame {
        message_type,
        payload,
    })
}

pub(crate) fn encode_frame(message_type: u16, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let total_length = FRAME_HEADER_BYTES
        .checked_add(payload.len())
        .ok_or(ProtocolError::Limit)?;
    if total_length > MAX_FRAME_BYTES {
        return Err(ProtocolError::Limit);
    }
    let payload_length = u32::try_from(payload.len()).map_err(|_| ProtocolError::Limit)?;
    let mut output = Vec::with_capacity(total_length);
    output.extend_from_slice(MAGIC);
    output.extend_from_slice(&FRAME_VERSION.to_be_bytes());
    output.extend_from_slice(&message_type.to_be_bytes());
    output.extend_from_slice(&payload_length.to_be_bytes());
    output.extend_from_slice(&sha256(payload));
    output.extend_from_slice(payload);
    Ok(output)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisterRequest {
    schema_version: String,
    expected_generation: u64,
    expected_transition_sha256: String,
    operation_id: String,
    authorization_nonce: String,
    target_fingerprint: String,
    target_selection_sha256: String,
    envelope_sha256: String,
    envelope_expires_at: String,
    external_exclusive_window_generation: u64,
    external_exclusive_window_evidence_sha256: String,
    external_exclusive_window_expires_at: String,
    official_source_evidence_sha256: String,
    native_runtime_identity_sha256: String,
    child_sandbox_policy_sha256: String,
    phase_exec_topology_policy_sha256: String,
    child_cgroup_policy_sha256: String,
    apply_invocation_evidence_sha256: String,
}

impl RegisterRequest {
    pub(crate) fn into_command(self) -> RegisterCommand {
        RegisterCommand::new(
            HeadCas::new(self.expected_generation, self.expected_transition_sha256),
            Candidate {
                schema_version: CANDIDATE_SCHEMA.to_owned(),
                operation_id: self.operation_id,
                authorization_nonce: self.authorization_nonce,
                target_fingerprint: self.target_fingerprint,
                target_selection_sha256: self.target_selection_sha256,
                envelope_sha256: self.envelope_sha256,
                envelope_expires_at: self.envelope_expires_at,
                external_exclusive_window_generation: self.external_exclusive_window_generation,
                external_exclusive_window_evidence_sha256: self
                    .external_exclusive_window_evidence_sha256,
                external_exclusive_window_expires_at: self.external_exclusive_window_expires_at,
                official_source_evidence_sha256: self.official_source_evidence_sha256,
                native_runtime_identity_sha256: self.native_runtime_identity_sha256,
                child_sandbox_policy_sha256: self.child_sandbox_policy_sha256,
                phase_exec_topology_policy_sha256: self.phase_exec_topology_policy_sha256,
                child_cgroup_policy_sha256: self.child_cgroup_policy_sha256,
                apply_invocation_evidence_sha256: self.apply_invocation_evidence_sha256,
                operation_authority_incarnation_sha256: String::new(),
                candidate_binding_sha256: String::new(),
                approval_challenge_sha256: String::new(),
                stored_at: String::new(),
                cutoff_at: String::new(),
            },
        )
    }

    fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&[
            ("schemaVersion", FieldValue::String(&self.schema_version)),
            (
                "expectedGeneration",
                FieldValue::Integer(self.expected_generation),
            ),
            (
                "expectedTransitionSha256",
                FieldValue::String(&self.expected_transition_sha256),
            ),
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
        ])
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        if self.schema_version != "openspell.hosted-migration-root-register-request.v1"
            || self.expected_generation > MAX_GENERATION
            || self.external_exclusive_window_generation == 0
            || self.external_exclusive_window_generation > MAX_GENERATION
            || ![
                &self.expected_transition_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.target_fingerprint,
                &self.target_selection_sha256,
                &self.envelope_sha256,
                &self.external_exclusive_window_evidence_sha256,
                &self.official_source_evidence_sha256,
                &self.native_runtime_identity_sha256,
                &self.child_sandbox_policy_sha256,
                &self.phase_exec_topology_policy_sha256,
                &self.child_cgroup_policy_sha256,
                &self.apply_invocation_evidence_sha256,
            ]
            .iter()
            .all(|value| is_lower_hex(value, 32))
        {
            return Err(ProtocolError::Payload);
        }
        validate_whole_timestamp(&self.envelope_expires_at)?;
        validate_millisecond_timestamp(&self.external_exclusive_window_expires_at)?;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StatusRequest {
    schema_version: String,
    operation_id: String,
}

impl StatusRequest {
    pub(crate) fn into_command(self) -> StatusCommand {
        StatusCommand::new(self.operation_id)
    }

    fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&[
            ("schemaVersion", FieldValue::String(&self.schema_version)),
            ("operationId", FieldValue::String(&self.operation_id)),
        ])
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        if self.schema_version != "openspell.hosted-migration-root-status-request.v1"
            || !is_lower_hex(&self.operation_id, 32)
        {
            return Err(ProtocolError::Payload);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumeRequest {
    schema_version: String,
    expected_generation: u64,
    expected_transition_sha256: String,
    operation_id: String,
    authorization_nonce: String,
    approval_grant_sha256: String,
    approval_grant_signature_sha256: String,
}

impl ConsumeRequest {
    pub(crate) fn into_command(self) -> ConsumeCommand {
        ConsumeCommand::new(
            HeadCas::new(self.expected_generation, self.expected_transition_sha256),
            self.operation_id,
            self.authorization_nonce,
            self.approval_grant_sha256,
            self.approval_grant_signature_sha256,
        )
    }

    fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        object(&[
            ("schemaVersion", FieldValue::String(&self.schema_version)),
            (
                "expectedGeneration",
                FieldValue::Integer(self.expected_generation),
            ),
            (
                "expectedTransitionSha256",
                FieldValue::String(&self.expected_transition_sha256),
            ),
            ("operationId", FieldValue::String(&self.operation_id)),
            (
                "authorizationNonce",
                FieldValue::String(&self.authorization_nonce),
            ),
            (
                "approvalGrantSha256",
                FieldValue::String(&self.approval_grant_sha256),
            ),
            (
                "approvalGrantSignatureSha256",
                FieldValue::String(&self.approval_grant_signature_sha256),
            ),
        ])
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        if self.schema_version != "openspell.hosted-migration-root-consume-request.v1"
            || self.expected_generation > MAX_GENERATION
            || ![
                &self.expected_transition_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.approval_grant_sha256,
                &self.approval_grant_signature_sha256,
            ]
            .iter()
            .all(|value| is_lower_hex(value, 32))
        {
            return Err(ProtocolError::Payload);
        }
        Ok(())
    }
}

pub(crate) enum SupervisorRequest {
    Register(Box<RegisterRequest>),
    Status(StatusRequest),
    Consume(ConsumeRequest),
}

pub(crate) enum SupervisorDecode {
    Request(SupervisorRequest),
    Malformed(SupervisorRequestFamily),
    Unclassified,
}

pub(crate) fn decode_supervisor(input: &[u8]) -> SupervisorDecode {
    let frame = match parse_frame(input) {
        Ok(frame) => frame,
        Err(_) => return SupervisorDecode::Unclassified,
    };
    match frame.message_type {
        SUPERVISOR_REGISTER => {
            let request = decode_exact(frame.payload, RegisterRequest::encode)
                .map_err(ProtocolError::from)
                .and_then(|request| {
                    request.validate()?;
                    Ok(request)
                });
            match request {
                Ok(request) => {
                    SupervisorDecode::Request(SupervisorRequest::Register(Box::new(request)))
                }
                Err(_) => SupervisorDecode::Malformed(SupervisorRequestFamily::RegisterCandidate),
            }
        }
        SUPERVISOR_STATUS => {
            let request = decode_exact(frame.payload, StatusRequest::encode)
                .map_err(ProtocolError::from)
                .and_then(|request| {
                    request.validate()?;
                    Ok(request)
                });
            match request {
                Ok(request) => SupervisorDecode::Request(SupervisorRequest::Status(request)),
                Err(_) => SupervisorDecode::Malformed(SupervisorRequestFamily::Status),
            }
        }
        SUPERVISOR_CONSUME => {
            let request = decode_exact(frame.payload, ConsumeRequest::encode)
                .map_err(ProtocolError::from)
                .and_then(|request| {
                    request.validate()?;
                    Ok(request)
                });
            match request {
                Ok(request) => SupervisorDecode::Request(SupervisorRequest::Consume(request)),
                Err(_) => SupervisorDecode::Malformed(SupervisorRequestFamily::ConsumeGrant),
            }
        }
        _ => SupervisorDecode::Unclassified,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApproveRequest {
    schema_version: String,
    expected_generation: u64,
    expected_transition_sha256: String,
    operation_id: String,
    authorization_nonce: String,
    envelope_sha256: String,
    action_challenge_sha256: String,
}

impl ApproveRequest {
    pub(crate) fn into_command(self) -> ApproveCommand {
        ApproveCommand::new(
            HeadCas::new(self.expected_generation, self.expected_transition_sha256),
            self.operation_id,
            self.authorization_nonce,
            self.envelope_sha256,
            self.action_challenge_sha256,
        )
    }

    fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        operator_payload(
            &self.schema_version,
            self.expected_generation,
            &self.expected_transition_sha256,
            &self.operation_id,
            &self.authorization_nonce,
            &self.envelope_sha256,
            &[],
            &self.action_challenge_sha256,
        )
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        validate_operator_common(
            &self.schema_version,
            "openspell.hosted-migration-root-approve-request.v1",
            self.expected_generation,
            &[
                &self.expected_transition_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.action_challenge_sha256,
            ],
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloseCandidateRequest {
    schema_version: String,
    expected_generation: u64,
    expected_transition_sha256: String,
    operation_id: String,
    authorization_nonce: String,
    envelope_sha256: String,
    action_challenge_sha256: String,
}

impl CloseCandidateRequest {
    pub(crate) fn into_command(self) -> CloseCandidateCommand {
        CloseCandidateCommand::new(
            HeadCas::new(self.expected_generation, self.expected_transition_sha256),
            self.operation_id,
            self.authorization_nonce,
            self.envelope_sha256,
            self.action_challenge_sha256,
        )
    }

    fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        operator_payload(
            &self.schema_version,
            self.expected_generation,
            &self.expected_transition_sha256,
            &self.operation_id,
            &self.authorization_nonce,
            &self.envelope_sha256,
            &[],
            &self.action_challenge_sha256,
        )
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        validate_operator_common(
            &self.schema_version,
            "openspell.hosted-migration-root-close-candidate-request.v1",
            self.expected_generation,
            &[
                &self.expected_transition_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.action_challenge_sha256,
            ],
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloseApprovalRequest {
    schema_version: String,
    expected_generation: u64,
    expected_transition_sha256: String,
    operation_id: String,
    authorization_nonce: String,
    envelope_sha256: String,
    approval_grant_sha256: String,
    approval_grant_signature_sha256: String,
    action_challenge_sha256: String,
}

impl CloseApprovalRequest {
    pub(crate) fn into_command(self) -> CloseApprovalCommand {
        CloseApprovalCommand::new(
            HeadCas::new(self.expected_generation, self.expected_transition_sha256),
            self.operation_id,
            self.authorization_nonce,
            self.envelope_sha256,
            self.approval_grant_sha256,
            self.approval_grant_signature_sha256,
            self.action_challenge_sha256,
        )
    }

    fn encode(&self) -> Result<Vec<u8>, CanonicalError> {
        operator_payload(
            &self.schema_version,
            self.expected_generation,
            &self.expected_transition_sha256,
            &self.operation_id,
            &self.authorization_nonce,
            &self.envelope_sha256,
            &[
                ("approvalGrantSha256", &self.approval_grant_sha256),
                (
                    "approvalGrantSignatureSha256",
                    &self.approval_grant_signature_sha256,
                ),
            ],
            &self.action_challenge_sha256,
        )
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        validate_operator_common(
            &self.schema_version,
            "openspell.hosted-migration-root-close-approval-request.v1",
            self.expected_generation,
            &[
                &self.expected_transition_sha256,
                &self.operation_id,
                &self.authorization_nonce,
                &self.envelope_sha256,
                &self.approval_grant_sha256,
                &self.approval_grant_signature_sha256,
                &self.action_challenge_sha256,
            ],
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn operator_payload<'a>(
    schema_version: &'a str,
    generation: u64,
    transition: &'a str,
    operation: &'a str,
    nonce: &'a str,
    envelope: &'a str,
    extra: &[(&'a str, &'a str)],
    challenge: &'a str,
) -> Result<Vec<u8>, CanonicalError> {
    let mut fields = vec![
        ("schemaVersion", FieldValue::String(schema_version)),
        ("expectedGeneration", FieldValue::Integer(generation)),
        ("expectedTransitionSha256", FieldValue::String(transition)),
        ("operationId", FieldValue::String(operation)),
        ("authorizationNonce", FieldValue::String(nonce)),
        ("envelopeSha256", FieldValue::String(envelope)),
    ];
    fields.extend(
        extra
            .iter()
            .map(|(key, value)| (*key, FieldValue::String(value))),
    );
    fields.push(("actionChallengeSha256", FieldValue::String(challenge)));
    object(&fields)
}

fn validate_operator_common(
    schema_version: &str,
    expected_schema: &str,
    generation: u64,
    digests: &[&String],
) -> Result<(), ProtocolError> {
    if schema_version != expected_schema
        || generation > MAX_GENERATION
        || !digests.iter().all(|value| is_lower_hex(value, 32))
    {
        return Err(ProtocolError::Payload);
    }
    Ok(())
}

pub(crate) enum OperatorRequest {
    Approve(ApproveRequest),
    CloseCandidate(CloseCandidateRequest),
    CloseApproval(CloseApprovalRequest),
}

pub(crate) enum OperatorDecode {
    Request(OperatorRequest),
    Malformed(OperatorRequestFamily),
    Unclassified,
}

pub(crate) fn decode_operator(input: &[u8]) -> OperatorDecode {
    let frame = match parse_frame(input) {
        Ok(frame) => frame,
        Err(_) => return OperatorDecode::Unclassified,
    };
    match frame.message_type {
        OPERATOR_APPROVE => {
            let request = decode_exact(frame.payload, ApproveRequest::encode)
                .map_err(ProtocolError::from)
                .and_then(|request| {
                    request.validate()?;
                    Ok(request)
                });
            match request {
                Ok(request) => OperatorDecode::Request(OperatorRequest::Approve(request)),
                Err(_) => OperatorDecode::Malformed(OperatorRequestFamily::ApproveCandidate),
            }
        }
        OPERATOR_CLOSE_CANDIDATE => {
            let request = decode_exact(frame.payload, CloseCandidateRequest::encode)
                .map_err(ProtocolError::from)
                .and_then(|request| {
                    request.validate()?;
                    Ok(request)
                });
            match request {
                Ok(request) => OperatorDecode::Request(OperatorRequest::CloseCandidate(request)),
                Err(_) => OperatorDecode::Malformed(OperatorRequestFamily::CloseExpiredCandidate),
            }
        }
        OPERATOR_CLOSE_APPROVAL => {
            let request = decode_exact(frame.payload, CloseApprovalRequest::encode)
                .map_err(ProtocolError::from)
                .and_then(|request| {
                    request.validate()?;
                    Ok(request)
                });
            match request {
                Ok(request) => OperatorDecode::Request(OperatorRequest::CloseApproval(request)),
                Err(_) => OperatorDecode::Malformed(OperatorRequestFamily::CloseExpiredApproval),
            }
        }
        _ => OperatorDecode::Unclassified,
    }
}

pub(crate) enum SupervisorResponse {
    Register(RegisterSuccess),
    Status(StatusResponse),
    Consume(ConsumeSuccess),
    Refusal(SupervisorRefusal),
}

pub(crate) struct RegisterSuccess {
    proof: DurableSuccess,
    generation: u64,
    transition_sha256: String,
    candidate_sha256: String,
    candidate_binding_sha256: String,
    approval_challenge_sha256: String,
    cutoff_at: String,
}

pub(crate) struct ConsumeSuccess {
    proof: DurableSuccess,
    generation: u64,
    transition_sha256: String,
    execution_ticket_canonical_hex: String,
    execution_ticket_raw_signature_hex: String,
}

pub(crate) enum StatusResponse {
    Absent {
        proof: VerifiedStatus,
    },
    Candidate {
        proof: VerifiedStatus,
        status: StatusAvailability,
        generation: u64,
        transition_sha256: String,
        candidate_sha256: String,
        candidate_binding_sha256: String,
        approval_challenge_sha256: String,
        cutoff_at: String,
    },
    Approved {
        proof: VerifiedStatus,
        status: StatusAvailability,
        generation: u64,
        transition_sha256: String,
        approval_grant_sha256: String,
        approval_grant_signature_sha256: String,
        expires_at: String,
    },
    Consumed {
        proof: VerifiedStatus,
        status: StatusAvailability,
        generation: u64,
        transition_sha256: String,
        execution_ticket_sha256: String,
        execution_ticket_signature_sha256: String,
        expires_at: String,
    },
    CandidateExpired {
        proof: VerifiedStatus,
        status: StatusAvailability,
        generation: u64,
        transition_sha256: String,
        candidate_sha256: String,
    },
    ApprovalExpired {
        proof: VerifiedStatus,
        status: StatusAvailability,
        generation: u64,
        transition_sha256: String,
        approval_grant_sha256: String,
        approval_grant_signature_sha256: String,
    },
}

impl RegisterSuccess {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn committed(
        proof: DurableSuccess,
        generation: u64,
        transition_sha256: String,
        candidate_sha256: String,
        candidate_binding_sha256: String,
        approval_challenge_sha256: String,
        cutoff_at: String,
    ) -> Self {
        Self {
            proof,
            generation,
            transition_sha256,
            candidate_sha256,
            candidate_binding_sha256,
            approval_challenge_sha256,
            cutoff_at,
        }
    }
}

impl ConsumeSuccess {
    pub(crate) fn committed(
        proof: DurableSuccess,
        generation: u64,
        transition_sha256: String,
        ticket_bytes: Box<[u8]>,
        ticket_signature: [u8; 64],
    ) -> Self {
        Self {
            proof,
            generation,
            transition_sha256,
            execution_ticket_canonical_hex: hex::encode(ticket_bytes),
            execution_ticket_raw_signature_hex: hex::encode(ticket_signature),
        }
    }
}

impl StatusResponse {
    pub(crate) fn absent(proof: VerifiedStatus) -> Self {
        Self::Absent { proof }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum StatusAvailability {
    Available,
    RecoveryOnly,
}

impl StatusAvailability {
    fn text(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::RecoveryOnly => "recovery_only",
        }
    }
}

pub(crate) struct SupervisorRefusal {
    pub(crate) family: SupervisorRequestFamily,
    pub(crate) code: RefusalCode,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum SupervisorRequestFamily {
    RegisterCandidate,
    Status,
    ConsumeGrant,
}

impl SupervisorRequestFamily {
    fn text(self) -> &'static str {
        match self {
            Self::RegisterCandidate => "register_candidate",
            Self::Status => "status",
            Self::ConsumeGrant => "consume_grant",
        }
    }
}

pub(crate) enum OperatorResponse {
    Approve(ApproveSuccess),
    CloseCandidate(CloseCandidateSuccess),
    CloseApproval(CloseApprovalSuccess),
    Refusal(OperatorRefusal),
}

pub(crate) struct ApproveSuccess {
    proof: DurableSuccess,
    generation: u64,
    transition_sha256: String,
    approval_grant_sha256: String,
    approval_grant_signature_sha256: String,
    expires_at: String,
}

pub(crate) struct CloseCandidateSuccess {
    proof: DurableSuccess,
    generation: u64,
    transition_sha256: String,
}

pub(crate) struct CloseApprovalSuccess {
    proof: DurableSuccess,
    generation: u64,
    transition_sha256: String,
}

impl ApproveSuccess {
    pub(crate) fn committed(
        proof: DurableSuccess,
        generation: u64,
        transition_sha256: String,
        approval_grant_sha256: String,
        approval_grant_signature_sha256: String,
        expires_at: String,
    ) -> Self {
        Self {
            proof,
            generation,
            transition_sha256,
            approval_grant_sha256,
            approval_grant_signature_sha256,
            expires_at,
        }
    }
}

impl CloseCandidateSuccess {
    pub(crate) fn committed(
        proof: DurableSuccess,
        generation: u64,
        transition_sha256: String,
    ) -> Self {
        Self {
            proof,
            generation,
            transition_sha256,
        }
    }
}

impl CloseApprovalSuccess {
    pub(crate) fn committed(
        proof: DurableSuccess,
        generation: u64,
        transition_sha256: String,
    ) -> Self {
        Self {
            proof,
            generation,
            transition_sha256,
        }
    }
}

pub(crate) struct OperatorRefusal {
    pub(crate) family: OperatorRequestFamily,
    pub(crate) code: RefusalCode,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum OperatorRequestFamily {
    ApproveCandidate,
    CloseExpiredCandidate,
    CloseExpiredApproval,
}

impl OperatorRequestFamily {
    fn text(self) -> &'static str {
        match self {
            Self::ApproveCandidate => "approve_candidate",
            Self::CloseExpiredCandidate => "close_expired_candidate",
            Self::CloseExpiredApproval => "close_expired_approval",
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum RefusalCode {
    InvalidRequest,
    StaleCompareAndSet,
    InvalidState,
    PolicyMismatch,
    Expired,
    NotExpired,
    RecoveryOnly,
    JournalUnavailable,
    SignerUnavailable,
    ClockInvalid,
    EntropyUnavailable,
    NonceCollision,
}

impl RefusalCode {
    fn text(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::StaleCompareAndSet => "stale_compare_and_set",
            Self::InvalidState => "invalid_state",
            Self::PolicyMismatch => "policy_mismatch",
            Self::Expired => "expired",
            Self::NotExpired => "not_expired",
            Self::RecoveryOnly => "recovery_only",
            Self::JournalUnavailable => "journal_unavailable",
            Self::SignerUnavailable => "signer_unavailable",
            Self::ClockInvalid => "clock_invalid",
            Self::EntropyUnavailable => "entropy_unavailable",
            Self::NonceCollision => "nonce_collision",
        }
    }
}

pub(crate) struct SupervisorResponseFrame {
    bytes: Vec<u8>,
}

impl SupervisorResponseFrame {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

pub(crate) struct OperatorResponseFrame {
    bytes: Vec<u8>,
}

impl OperatorResponseFrame {
    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

pub(crate) fn encode_supervisor_response(
    response: SupervisorResponse,
) -> Result<SupervisorResponseFrame, ProtocolError> {
    let (message_type, payload) = match response {
        SupervisorResponse::Register(success) => (
            SUPERVISOR_REGISTER_SUCCESS,
            encode_register_success(&success)?,
        ),
        SupervisorResponse::Status(status) => (SUPERVISOR_STATUS_SUCCESS, encode_status(&status)?),
        SupervisorResponse::Consume(success) => (
            SUPERVISOR_CONSUME_SUCCESS,
            encode_consume_success(&success)?,
        ),
        SupervisorResponse::Refusal(refusal) => (
            SUPERVISOR_REFUSAL,
            encode_refusal(
                "openspell.hosted-migration-root-supervisor-refusal.v1",
                refusal.family.text(),
                refusal.code,
            )?,
        ),
    };
    Ok(SupervisorResponseFrame {
        bytes: encode_frame(message_type, &payload)?,
    })
}

pub(crate) fn encode_operator_response(
    response: OperatorResponse,
) -> Result<OperatorResponseFrame, ProtocolError> {
    let (message_type, payload) = match response {
        OperatorResponse::Approve(success) => {
            (OPERATOR_APPROVE_SUCCESS, encode_approve_success(&success)?)
        }
        OperatorResponse::CloseCandidate(success) => (
            OPERATOR_CLOSE_CANDIDATE_SUCCESS,
            encode_terminal_success(
                "openspell.hosted-migration-root-close-candidate-success.v1",
                success.generation,
                &success.transition_sha256,
                "candidate_expired",
            )?,
        ),
        OperatorResponse::CloseApproval(success) => (
            OPERATOR_CLOSE_APPROVAL_SUCCESS,
            encode_terminal_success(
                "openspell.hosted-migration-root-close-approval-success.v1",
                success.generation,
                &success.transition_sha256,
                "approval_expired",
            )?,
        ),
        OperatorResponse::Refusal(refusal) => (
            OPERATOR_REFUSAL,
            encode_refusal(
                "openspell.hosted-migration-root-operator-refusal.v1",
                refusal.family.text(),
                refusal.code,
            )?,
        ),
    };
    Ok(OperatorResponseFrame {
        bytes: encode_frame(message_type, &payload)?,
    })
}

fn encode_register_success(success: &RegisterSuccess) -> Result<Vec<u8>, ProtocolError> {
    validate_generation_and_digests(
        success.generation,
        &[
            &success.transition_sha256,
            &success.candidate_sha256,
            &success.candidate_binding_sha256,
            &success.approval_challenge_sha256,
        ],
    )?;
    crate::canonical::validate_derived_timestamp(&success.cutoff_at)?;
    Ok(object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-register-success.v1"),
        ),
        ("status", FieldValue::String("committed")),
        ("generation", FieldValue::Integer(success.generation)),
        (
            "transitionSha256",
            FieldValue::String(&success.transition_sha256),
        ),
        ("state", FieldValue::String("candidate_registered")),
        (
            "candidateSha256",
            FieldValue::String(&success.candidate_sha256),
        ),
        (
            "candidateBindingSha256",
            FieldValue::String(&success.candidate_binding_sha256),
        ),
        (
            "approvalChallengeSha256",
            FieldValue::String(&success.approval_challenge_sha256),
        ),
        ("cutoffAt", FieldValue::String(&success.cutoff_at)),
    ])?)
}

fn encode_consume_success(success: &ConsumeSuccess) -> Result<Vec<u8>, ProtocolError> {
    validate_generation_and_digests(success.generation, &[&success.transition_sha256])?;
    if success.execution_ticket_raw_signature_hex.len() != 128
        || !is_lower_hex_text(&success.execution_ticket_raw_signature_hex)
        || success.execution_ticket_canonical_hex.is_empty()
        || !success
            .execution_ticket_canonical_hex
            .len()
            .is_multiple_of(2)
        || !is_lower_hex_text(&success.execution_ticket_canonical_hex)
    {
        return Err(ProtocolError::Payload);
    }
    let ticket_bytes =
        hex::decode(&success.execution_ticket_canonical_hex).map_err(|_| ProtocolError::Payload)?;
    let ticket = ExecutionTicket::decode(&ticket_bytes)?;
    let signature_bytes = hex::decode(&success.execution_ticket_raw_signature_hex)
        .map_err(|_| ProtocolError::Payload)?;
    if ticket.detached_signature_sha256 != sha256_hex(&signature_bytes) {
        return Err(ProtocolError::Payload);
    }
    Ok(object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-consume-success.v1"),
        ),
        ("status", FieldValue::String("committed")),
        ("generation", FieldValue::Integer(success.generation)),
        (
            "transitionSha256",
            FieldValue::String(&success.transition_sha256),
        ),
        ("state", FieldValue::String("consumed")),
        (
            "executionTicketCanonicalHex",
            FieldValue::String(&success.execution_ticket_canonical_hex),
        ),
        (
            "executionTicketRawSignatureHex",
            FieldValue::String(&success.execution_ticket_raw_signature_hex),
        ),
    ])?)
}

fn encode_approve_success(success: &ApproveSuccess) -> Result<Vec<u8>, ProtocolError> {
    validate_generation_and_digests(
        success.generation,
        &[
            &success.transition_sha256,
            &success.approval_grant_sha256,
            &success.approval_grant_signature_sha256,
        ],
    )?;
    crate::canonical::validate_derived_timestamp(&success.expires_at)?;
    Ok(object(&[
        (
            "schemaVersion",
            FieldValue::String("openspell.hosted-migration-root-approve-success.v1"),
        ),
        ("status", FieldValue::String("committed")),
        ("generation", FieldValue::Integer(success.generation)),
        (
            "transitionSha256",
            FieldValue::String(&success.transition_sha256),
        ),
        ("state", FieldValue::String("approved")),
        (
            "approvalGrantSha256",
            FieldValue::String(&success.approval_grant_sha256),
        ),
        (
            "approvalGrantSignatureSha256",
            FieldValue::String(&success.approval_grant_signature_sha256),
        ),
        ("expiresAt", FieldValue::String(&success.expires_at)),
    ])?)
}

fn encode_terminal_success(
    schema: &str,
    generation: u64,
    transition_sha256: &str,
    state: &str,
) -> Result<Vec<u8>, ProtocolError> {
    validate_generation_and_digests(generation, &[&transition_sha256.to_owned()])?;
    Ok(object(&[
        ("schemaVersion", FieldValue::String(schema)),
        ("status", FieldValue::String("committed")),
        ("generation", FieldValue::Integer(generation)),
        ("transitionSha256", FieldValue::String(transition_sha256)),
        ("state", FieldValue::String(state)),
    ])?)
}

fn encode_status(status: &StatusResponse) -> Result<Vec<u8>, ProtocolError> {
    match status {
        StatusResponse::Absent { .. } => Ok(object(&[
            (
                "schemaVersion",
                FieldValue::String("openspell.hosted-migration-root-status-absent.v1"),
            ),
            ("status", FieldValue::String("absent")),
        ])?),
        StatusResponse::Candidate {
            proof: _,
            status,
            generation,
            transition_sha256,
            candidate_sha256,
            candidate_binding_sha256,
            approval_challenge_sha256,
            cutoff_at,
        } => {
            validate_generation_and_digests(
                *generation,
                &[
                    transition_sha256,
                    candidate_sha256,
                    candidate_binding_sha256,
                    approval_challenge_sha256,
                ],
            )?;
            crate::canonical::validate_derived_timestamp(cutoff_at)?;
            Ok(object(&[
                (
                    "schemaVersion",
                    FieldValue::String("openspell.hosted-migration-root-status-candidate.v1"),
                ),
                ("status", FieldValue::String(status.text())),
                ("generation", FieldValue::Integer(*generation)),
                ("transitionSha256", FieldValue::String(transition_sha256)),
                ("state", FieldValue::String("candidate_registered")),
                ("candidateSha256", FieldValue::String(candidate_sha256)),
                (
                    "candidateBindingSha256",
                    FieldValue::String(candidate_binding_sha256),
                ),
                (
                    "approvalChallengeSha256",
                    FieldValue::String(approval_challenge_sha256),
                ),
                ("cutoffAt", FieldValue::String(cutoff_at)),
            ])?)
        }
        StatusResponse::Approved {
            proof: _,
            status,
            generation,
            transition_sha256,
            approval_grant_sha256,
            approval_grant_signature_sha256,
            expires_at,
        } => {
            validate_generation_and_digests(
                *generation,
                &[
                    transition_sha256,
                    approval_grant_sha256,
                    approval_grant_signature_sha256,
                ],
            )?;
            crate::canonical::validate_derived_timestamp(expires_at)?;
            Ok(object(&[
                (
                    "schemaVersion",
                    FieldValue::String("openspell.hosted-migration-root-status-approved.v1"),
                ),
                ("status", FieldValue::String(status.text())),
                ("generation", FieldValue::Integer(*generation)),
                ("transitionSha256", FieldValue::String(transition_sha256)),
                ("state", FieldValue::String("approved")),
                (
                    "approvalGrantSha256",
                    FieldValue::String(approval_grant_sha256),
                ),
                (
                    "approvalGrantSignatureSha256",
                    FieldValue::String(approval_grant_signature_sha256),
                ),
                ("expiresAt", FieldValue::String(expires_at)),
            ])?)
        }
        StatusResponse::Consumed {
            proof: _,
            status,
            generation,
            transition_sha256,
            execution_ticket_sha256,
            execution_ticket_signature_sha256,
            expires_at,
        } => {
            validate_generation_and_digests(
                *generation,
                &[
                    transition_sha256,
                    execution_ticket_sha256,
                    execution_ticket_signature_sha256,
                ],
            )?;
            crate::canonical::validate_derived_timestamp(expires_at)?;
            Ok(object(&[
                (
                    "schemaVersion",
                    FieldValue::String("openspell.hosted-migration-root-status-consumed.v1"),
                ),
                ("status", FieldValue::String(status.text())),
                ("generation", FieldValue::Integer(*generation)),
                ("transitionSha256", FieldValue::String(transition_sha256)),
                ("state", FieldValue::String("consumed")),
                (
                    "executionTicketSha256",
                    FieldValue::String(execution_ticket_sha256),
                ),
                (
                    "executionTicketSignatureSha256",
                    FieldValue::String(execution_ticket_signature_sha256),
                ),
                ("expiresAt", FieldValue::String(expires_at)),
            ])?)
        }
        StatusResponse::CandidateExpired {
            proof: _,
            status,
            generation,
            transition_sha256,
            candidate_sha256,
        } => encode_status_terminal(
            "openspell.hosted-migration-root-status-candidate-expired.v1",
            status,
            *generation,
            transition_sha256,
            "candidate_expired",
            &[("candidateSha256", candidate_sha256)],
        ),
        StatusResponse::ApprovalExpired {
            proof: _,
            status,
            generation,
            transition_sha256,
            approval_grant_sha256,
            approval_grant_signature_sha256,
        } => encode_status_terminal(
            "openspell.hosted-migration-root-status-approval-expired.v1",
            status,
            *generation,
            transition_sha256,
            "approval_expired",
            &[
                ("approvalGrantSha256", approval_grant_sha256),
                (
                    "approvalGrantSignatureSha256",
                    approval_grant_signature_sha256,
                ),
            ],
        ),
    }
}

fn encode_status_terminal(
    schema: &str,
    status: &StatusAvailability,
    generation: u64,
    transition_sha256: &str,
    state: &str,
    fields: &[(&str, &String)],
) -> Result<Vec<u8>, ProtocolError> {
    let mut digests = vec![transition_sha256];
    digests.extend(fields.iter().map(|(_, value)| value.as_str()));
    if generation == 0
        || generation > MAX_GENERATION
        || !digests.iter().all(|value| is_lower_hex(value, 32))
    {
        return Err(ProtocolError::Payload);
    }
    let mut output = vec![
        ("schemaVersion", FieldValue::String(schema)),
        ("status", FieldValue::String(status.text())),
        ("generation", FieldValue::Integer(generation)),
        ("transitionSha256", FieldValue::String(transition_sha256)),
        ("state", FieldValue::String(state)),
    ];
    output.extend(
        fields
            .iter()
            .map(|(key, value)| (*key, FieldValue::String(value))),
    );
    Ok(object(&output)?)
}

fn encode_refusal(
    schema: &str,
    request_family: &str,
    code: RefusalCode,
) -> Result<Vec<u8>, ProtocolError> {
    Ok(object(&[
        ("schemaVersion", FieldValue::String(schema)),
        ("requestFamily", FieldValue::String(request_family)),
        ("status", FieldValue::String("refused")),
        ("code", FieldValue::String(code.text())),
    ])?)
}

fn validate_generation_and_digests(
    generation: u64,
    digests: &[&String],
) -> Result<(), ProtocolError> {
    if generation == 0
        || generation > MAX_GENERATION
        || !digests.iter().all(|value| is_lower_hex(value, 32))
    {
        return Err(ProtocolError::Payload);
    }
    Ok(())
}

fn is_lower_hex_text(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
