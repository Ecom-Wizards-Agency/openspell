//! Fixed supervisor and attended-operator protocol codecs.

use serde::Deserialize;

use crate::canonical::{
    CanonicalError, FieldValue, decode_exact, is_lower_hex, object, validate_millisecond_timestamp,
    validate_whole_timestamp,
};
use crate::crypto::sha256;

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StatusRequest {
    schema_version: String,
    operation_id: String,
}

impl StatusRequest {
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SupervisorRequest {
    Register(Box<RegisterRequest>),
    Status(StatusRequest),
    Consume(ConsumeRequest),
}

pub(crate) fn decode_supervisor(input: &[u8]) -> Result<SupervisorRequest, ProtocolError> {
    let frame = parse_frame(input)?;
    match frame.message_type {
        SUPERVISOR_REGISTER => {
            let request = decode_exact(frame.payload, RegisterRequest::encode)?;
            request.validate()?;
            Ok(SupervisorRequest::Register(Box::new(request)))
        }
        SUPERVISOR_STATUS => {
            let request = decode_exact(frame.payload, StatusRequest::encode)?;
            request.validate()?;
            Ok(SupervisorRequest::Status(request))
        }
        SUPERVISOR_CONSUME => {
            let request = decode_exact(frame.payload, ConsumeRequest::encode)?;
            request.validate()?;
            Ok(SupervisorRequest::Consume(request))
        }
        _ => Err(ProtocolError::MessageType),
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum OperatorRequest {
    Approve(ApproveRequest),
    CloseCandidate(CloseCandidateRequest),
    CloseApproval(CloseApprovalRequest),
}

pub(crate) fn decode_operator(input: &[u8]) -> Result<OperatorRequest, ProtocolError> {
    let frame = parse_frame(input)?;
    match frame.message_type {
        OPERATOR_APPROVE => {
            let request = decode_exact(frame.payload, ApproveRequest::encode)?;
            request.validate()?;
            Ok(OperatorRequest::Approve(request))
        }
        OPERATOR_CLOSE_CANDIDATE => {
            let request = decode_exact(frame.payload, CloseCandidateRequest::encode)?;
            request.validate()?;
            Ok(OperatorRequest::CloseCandidate(request))
        }
        OPERATOR_CLOSE_APPROVAL => {
            let request = decode_exact(frame.payload, CloseApprovalRequest::encode)?;
            request.validate()?;
            Ok(OperatorRequest::CloseApproval(request))
        }
        _ => Err(ProtocolError::MessageType),
    }
}
