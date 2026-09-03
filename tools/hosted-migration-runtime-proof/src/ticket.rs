use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::canonical::{Digest32, canonical_json, sha256};

const MAX_RECORD_BYTES: usize = 16 * 1024;
const GRANT_SCHEMA: &str = "openspell.hosted-migration-approval-grant.v1";
const TICKET_SCHEMA: &str = "openspell.hosted-migration-execution-ticket.v1";
const GRANT_DOMAIN: &str = "openspell.hosted-migration-approval-grant-signature.v1";
const TICKET_DOMAIN: &str = "openspell.hosted-migration-execution-ticket-signature.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TicketRefusal {
    InvalidRecord,
    InvalidTime,
    KeyMismatch,
    SignatureMismatch,
    BindingMismatch,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalGrant {
    schema_version: String,
    operation_id: String,
    authorization_nonce: String,
    target_fingerprint: String,
    target_selection_sha256: String,
    envelope_sha256: String,
    external_exclusive_window_generation: u64,
    external_exclusive_window_evidence_sha256: String,
    official_source_evidence_sha256: String,
    native_runtime_identity_sha256: String,
    child_sandbox_policy_sha256: String,
    phase_exec_topology_policy_sha256: String,
    child_cgroup_policy_sha256: String,
    apply_invocation_evidence_sha256: String,
    issued_at: String,
    expires_at: String,
    authenticated_operator_identity_sha256: String,
    os_authentication_session_sha256: String,
    authenticated_at: String,
    state: String,
    issuer_public_key_sha256: String,
    detached_signature_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutionTicket {
    schema_version: String,
    approval_grant_sha256: String,
    approval_grant_signature_sha256: String,
    ticket_nonce: String,
    operation_id: String,
    authorization_nonce: String,
    target_fingerprint: String,
    target_selection_sha256: String,
    envelope_sha256: String,
    external_exclusive_window_generation: u64,
    external_exclusive_window_evidence_sha256: String,
    official_source_evidence_sha256: String,
    native_runtime_identity_sha256: String,
    child_sandbox_policy_sha256: String,
    phase_exec_topology_policy_sha256: String,
    child_cgroup_policy_sha256: String,
    apply_invocation_evidence_sha256: String,
    consumed_at: String,
    expires_at: String,
    state: String,
    issuer_public_key_sha256: String,
    detached_signature_sha256: String,
}

pub(crate) struct VerifiedConsumedTicket {
    operation_id: Digest32,
    authorization_nonce: Digest32,
    ticket_nonce: Digest32,
    ticket_sha256: Digest32,
    ticket_signature_sha256: Digest32,
}

impl VerifiedConsumedTicket {
    pub(crate) fn binding_digests(&self) -> [&Digest32; 5] {
        [
            &self.operation_id,
            &self.authorization_nonce,
            &self.ticket_nonce,
            &self.ticket_sha256,
            &self.ticket_signature_sha256,
        ]
    }
}

pub(crate) fn verify_consumed_ticket(
    grant_bytes: &[u8],
    grant_signature: &[u8; 64],
    ticket_bytes: &[u8],
    ticket_signature: &[u8; 64],
    pinned_public_key: &[u8; 32],
) -> Result<VerifiedConsumedTicket, TicketRefusal> {
    let grant: ApprovalGrant = decode_exact(grant_bytes)?;
    let ticket: ExecutionTicket = decode_exact(ticket_bytes)?;
    validate_grant(&grant)?;
    validate_ticket(&ticket)?;
    verify_signature(
        GRANT_DOMAIN,
        grant_bytes,
        &grant.detached_signature_sha256,
        &grant.issuer_public_key_sha256,
        grant_signature,
        pinned_public_key,
    )?;
    verify_signature(
        TICKET_DOMAIN,
        ticket_bytes,
        &ticket.detached_signature_sha256,
        &ticket.issuer_public_key_sha256,
        ticket_signature,
        pinned_public_key,
    )?;
    validate_bindings(&grant, grant_bytes, grant_signature, &ticket)?;

    Ok(VerifiedConsumedTicket {
        operation_id: parse_digest(&ticket.operation_id)?,
        authorization_nonce: parse_digest(&ticket.authorization_nonce)?,
        ticket_nonce: parse_digest(&ticket.ticket_nonce)?,
        ticket_sha256: sha256(ticket_bytes),
        ticket_signature_sha256: sha256(ticket_signature),
    })
}

fn decode_exact<T>(bytes: &[u8]) -> Result<T, TicketRefusal>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    if bytes.is_empty() || bytes.len() > MAX_RECORD_BYTES {
        return Err(TicketRefusal::InvalidRecord);
    }
    let value: T = serde_json::from_slice(bytes).map_err(|_| TicketRefusal::InvalidRecord)?;
    let canonical = canonical_json(&value).map_err(|_| TicketRefusal::InvalidRecord)?;
    if canonical != bytes {
        return Err(TicketRefusal::InvalidRecord);
    }
    Ok(value)
}

fn validate_grant(grant: &ApprovalGrant) -> Result<(), TicketRefusal> {
    if grant.schema_version != GRANT_SCHEMA
        || grant.state != "approved"
        || grant.external_exclusive_window_generation == 0
    {
        return Err(TicketRefusal::InvalidRecord);
    }
    for digest in grant_digests(grant) {
        parse_digest(digest)?;
    }
    let issued = parse_whole_time(&grant.issued_at)?;
    let expires = parse_derived_time(&grant.expires_at)?;
    let authenticated = parse_whole_time(&grant.authenticated_at)?;
    let authentication_age = issued - authenticated;
    if expires <= issued
        || authentication_age.is_negative()
        || authentication_age > time::Duration::minutes(5)
        || expires - issued > time::Duration::minutes(15)
    {
        return Err(TicketRefusal::InvalidTime);
    }
    Ok(())
}

fn validate_ticket(ticket: &ExecutionTicket) -> Result<(), TicketRefusal> {
    if ticket.schema_version != TICKET_SCHEMA
        || ticket.state != "consumed"
        || ticket.external_exclusive_window_generation == 0
    {
        return Err(TicketRefusal::InvalidRecord);
    }
    for digest in ticket_digests(ticket) {
        parse_digest(digest)?;
    }
    let consumed = parse_whole_time(&ticket.consumed_at)?;
    let expires = parse_derived_time(&ticket.expires_at)?;
    if expires <= consumed {
        return Err(TicketRefusal::InvalidTime);
    }
    Ok(())
}

fn verify_signature(
    domain: &str,
    complete_bytes: &[u8],
    signature_sha256: &str,
    issuer_public_key_sha256: &str,
    signature_bytes: &[u8; 64],
    pinned_public_key: &[u8; 32],
) -> Result<(), TicketRefusal> {
    if parse_digest(issuer_public_key_sha256)? != sha256(pinned_public_key) {
        return Err(TicketRefusal::KeyMismatch);
    }
    if parse_digest(signature_sha256)? != sha256(signature_bytes) {
        return Err(TicketRefusal::SignatureMismatch);
    }
    let unsigned = unsigned_bytes(complete_bytes, signature_sha256)?;
    let mut preimage = Vec::with_capacity(domain.len() + 1 + unsigned.len());
    preimage.extend_from_slice(domain.as_bytes());
    preimage.push(b'\n');
    preimage.extend_from_slice(&unsigned);
    let key = VerifyingKey::from_bytes(pinned_public_key)
        .map_err(|_| TicketRefusal::SignatureMismatch)?;
    key.verify_strict(&preimage, &Signature::from_bytes(signature_bytes))
        .map_err(|_| TicketRefusal::SignatureMismatch)
}

fn unsigned_bytes(complete: &[u8], signature_sha256: &str) -> Result<Vec<u8>, TicketRefusal> {
    let suffix = format!(",\n  \"detachedSignatureSha256\": \"{signature_sha256}\"\n}}\n");
    if !complete.ends_with(suffix.as_bytes()) {
        return Err(TicketRefusal::InvalidRecord);
    }
    let mut unsigned = complete[..complete.len() - suffix.len()].to_vec();
    unsigned.extend_from_slice(b"\n}\n");
    Ok(unsigned)
}

fn validate_bindings(
    grant: &ApprovalGrant,
    grant_bytes: &[u8],
    grant_signature: &[u8; 64],
    ticket: &ExecutionTicket,
) -> Result<(), TicketRefusal> {
    let issued = parse_whole_time(&grant.issued_at)?;
    let consumed = parse_whole_time(&ticket.consumed_at)?;
    let exact = ticket.approval_grant_sha256 == sha256(grant_bytes).to_hex()
        && ticket.approval_grant_signature_sha256 == sha256(grant_signature).to_hex()
        && ticket.operation_id == grant.operation_id
        && ticket.authorization_nonce == grant.authorization_nonce
        && ticket.target_fingerprint == grant.target_fingerprint
        && ticket.target_selection_sha256 == grant.target_selection_sha256
        && ticket.envelope_sha256 == grant.envelope_sha256
        && ticket.external_exclusive_window_generation
            == grant.external_exclusive_window_generation
        && ticket.external_exclusive_window_evidence_sha256
            == grant.external_exclusive_window_evidence_sha256
        && ticket.official_source_evidence_sha256 == grant.official_source_evidence_sha256
        && ticket.native_runtime_identity_sha256 == grant.native_runtime_identity_sha256
        && ticket.child_sandbox_policy_sha256 == grant.child_sandbox_policy_sha256
        && ticket.phase_exec_topology_policy_sha256 == grant.phase_exec_topology_policy_sha256
        && ticket.child_cgroup_policy_sha256 == grant.child_cgroup_policy_sha256
        && ticket.apply_invocation_evidence_sha256 == grant.apply_invocation_evidence_sha256
        && ticket.expires_at == grant.expires_at
        && ticket.issuer_public_key_sha256 == grant.issuer_public_key_sha256
        && consumed >= issued;
    if exact {
        Ok(())
    } else {
        Err(TicketRefusal::BindingMismatch)
    }
}

fn parse_digest(value: &str) -> Result<Digest32, TicketRefusal> {
    Digest32::parse_hex(value).map_err(|_| TicketRefusal::InvalidRecord)
}

fn parse_whole_time(value: &str) -> Result<OffsetDateTime, TicketRefusal> {
    parse_shaped_time(value, false)
}

fn parse_derived_time(value: &str) -> Result<OffsetDateTime, TicketRefusal> {
    match value.len() {
        20 => parse_shaped_time(value, false),
        24 => parse_shaped_time(value, true),
        _ => Err(TicketRefusal::InvalidTime),
    }
}

fn parse_shaped_time(value: &str, milliseconds: bool) -> Result<OffsetDateTime, TicketRefusal> {
    let bytes = value.as_bytes();
    let expected_len = if milliseconds { 24 } else { 20 };
    if bytes.len() != expected_len
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
        || (milliseconds && bytes.get(19) != Some(&b'.'))
    {
        return Err(TicketRefusal::InvalidTime);
    }
    for (index, byte) in bytes.iter().enumerate() {
        let punctuation = matches!(index, 4 | 7 | 10 | 13 | 16)
            || index + 1 == bytes.len()
            || (milliseconds && index == 19);
        if !punctuation && !byte.is_ascii_digit() {
            return Err(TicketRefusal::InvalidTime);
        }
    }
    let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| TicketRefusal::InvalidTime)?;
    let year = parsed.year();
    if !(2020..2100).contains(&year) {
        return Err(TicketRefusal::InvalidTime);
    }
    Ok(parsed)
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

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GoldenRecord {
        canonical_bytes: Vec<u8>,
        raw_signature_bytes: Vec<u8>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct GoldenCorpus {
        schema_version: u8,
        public_key_bytes: Vec<u8>,
        approval_grant: GoldenRecord,
        execution_ticket: GoldenRecord,
    }

    fn corpus() -> GoldenCorpus {
        serde_json::from_str(include_str!(
            "../fixtures/wp199-grant-ticket-v1.golden.json"
        ))
        .expect("WP-199 golden corpus")
    }

    fn exact<const N: usize>(bytes: &[u8]) -> [u8; N] {
        bytes.try_into().expect("exact golden byte length")
    }

    #[test]
    fn independently_verifies_the_exact_wp199_grant_and_ticket() {
        let corpus = corpus();
        assert_eq!(corpus.schema_version, 1);
        let verified = verify_consumed_ticket(
            &corpus.approval_grant.canonical_bytes,
            &exact(&corpus.approval_grant.raw_signature_bytes),
            &corpus.execution_ticket.canonical_bytes,
            &exact(&corpus.execution_ticket.raw_signature_bytes),
            &exact(&corpus.public_key_bytes),
        )
        .expect("independent verification");
        assert_eq!(verified.binding_digests().len(), 5);
    }

    #[test]
    fn every_input_class_mutation_refuses_without_echo() {
        let corpus = corpus();
        let public_key = exact(&corpus.public_key_bytes);
        let grant_signature = exact(&corpus.approval_grant.raw_signature_bytes);
        let ticket_signature = exact(&corpus.execution_ticket.raw_signature_bytes);

        let mut changed_grant = corpus.approval_grant.canonical_bytes.clone();
        changed_grant[100] ^= 1;
        assert!(
            verify_consumed_ticket(
                &changed_grant,
                &grant_signature,
                &corpus.execution_ticket.canonical_bytes,
                &ticket_signature,
                &public_key,
            )
            .is_err()
        );

        let mut changed_ticket = corpus.execution_ticket.canonical_bytes.clone();
        changed_ticket[100] ^= 1;
        assert!(
            verify_consumed_ticket(
                &corpus.approval_grant.canonical_bytes,
                &grant_signature,
                &changed_ticket,
                &ticket_signature,
                &public_key,
            )
            .is_err()
        );

        let mut changed_signature = ticket_signature;
        changed_signature[0] ^= 1;
        assert_eq!(
            verify_consumed_ticket(
                &corpus.approval_grant.canonical_bytes,
                &grant_signature,
                &corpus.execution_ticket.canonical_bytes,
                &changed_signature,
                &public_key,
            )
            .err(),
            Some(TicketRefusal::SignatureMismatch)
        );

        let mut changed_key = public_key;
        changed_key[0] ^= 1;
        assert_eq!(
            verify_consumed_ticket(
                &corpus.approval_grant.canonical_bytes,
                &grant_signature,
                &corpus.execution_ticket.canonical_bytes,
                &ticket_signature,
                &changed_key,
            )
            .err(),
            Some(TicketRefusal::KeyMismatch)
        );
    }

    #[test]
    fn every_record_field_and_signature_byte_mutation_refuses() {
        let corpus = corpus();
        let public_key = exact(&corpus.public_key_bytes);
        let grant_signature = exact(&corpus.approval_grant.raw_signature_bytes);
        let ticket_signature = exact(&corpus.execution_ticket.raw_signature_bytes);

        assert_each_field_refuses(&corpus.approval_grant.canonical_bytes, |mutated| {
            verify_consumed_ticket(
                mutated,
                &grant_signature,
                &corpus.execution_ticket.canonical_bytes,
                &ticket_signature,
                &public_key,
            )
            .is_err()
        });
        assert_each_field_refuses(&corpus.execution_ticket.canonical_bytes, |mutated| {
            verify_consumed_ticket(
                &corpus.approval_grant.canonical_bytes,
                &grant_signature,
                mutated,
                &ticket_signature,
                &public_key,
            )
            .is_err()
        });

        for index in 0..grant_signature.len() {
            let mut changed = grant_signature;
            changed[index] ^= 1;
            assert!(
                verify_consumed_ticket(
                    &corpus.approval_grant.canonical_bytes,
                    &changed,
                    &corpus.execution_ticket.canonical_bytes,
                    &ticket_signature,
                    &public_key,
                )
                .is_err()
            );
        }
        for index in 0..ticket_signature.len() {
            let mut changed = ticket_signature;
            changed[index] ^= 1;
            assert!(
                verify_consumed_ticket(
                    &corpus.approval_grant.canonical_bytes,
                    &grant_signature,
                    &corpus.execution_ticket.canonical_bytes,
                    &changed,
                    &public_key,
                )
                .is_err()
            );
        }
        for index in 0..public_key.len() {
            let mut changed = public_key;
            changed[index] ^= 1;
            assert!(
                verify_consumed_ticket(
                    &corpus.approval_grant.canonical_bytes,
                    &grant_signature,
                    &corpus.execution_ticket.canonical_bytes,
                    &ticket_signature,
                    &changed,
                )
                .is_err()
            );
        }
    }

    fn assert_each_field_refuses(canonical: &[u8], refuses: impl Fn(&[u8]) -> bool) {
        let text = std::str::from_utf8(canonical).expect("UTF-8 golden record");
        let field_lines: Vec<&str> = text
            .lines()
            .filter(|line| line.starts_with("  \"") && line.contains(": "))
            .collect();
        assert!(!field_lines.is_empty());
        for line in field_lines {
            let offset = text.find(line).expect("unique field line");
            let value_offset = line.find(": ").expect("field separator") + 2;
            let mut changed = canonical.to_vec();
            let first = offset + value_offset + usize::from(line.as_bytes()[value_offset] == b'\"');
            changed[first] = match changed[first] {
                b'0'..=b'8' => changed[first] + 1,
                b'9' => b'8',
                b'a' => b'b',
                _ => b'a',
            };
            assert!(refuses(&changed), "mutation accepted for {line}");
        }
    }
}
