//! Record-specific hashing, signing and verification.

use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest as _, Sha256};

use crate::canonical::CanonicalError;
use crate::records::{
    ApprovalExpiredTransition, ApprovalGrant, ApprovedTransition, CandidateExpiredTransition,
    CandidateRegisteredTransition, ConsumedTransition, ExecutionTicket, GRANT_DOMAIN,
    TICKET_DOMAIN, Transition,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CryptoError {
    Canonical,
    KeyPin,
    SignatureDigest,
    Signature,
}

impl From<CanonicalError> for CryptoError {
    fn from(_: CanonicalError) -> Self {
        Self::Canonical
    }
}

pub(crate) fn sha256(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

pub(crate) fn sha256_hex(input: &[u8]) -> String {
    hex::encode(sha256(input))
}

fn preimage(domain: &str, canonical_unsigned: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(domain.len() + 1 + canonical_unsigned.len());
    bytes.extend_from_slice(domain.as_bytes());
    bytes.push(b'\n');
    bytes.extend_from_slice(canonical_unsigned);
    bytes
}

pub(crate) fn verify_grant(
    grant: &ApprovalGrant,
    signature_bytes: &[u8; 64],
    pinned_public_key: &[u8; 32],
) -> Result<(), CryptoError> {
    grant.validate()?;
    verify_exact(
        GRANT_DOMAIN,
        &grant.encode_unsigned()?,
        &grant.issuer_public_key_sha256,
        &grant.detached_signature_sha256,
        signature_bytes,
        pinned_public_key,
    )
}

pub(crate) fn verify_ticket(
    ticket: &ExecutionTicket,
    signature_bytes: &[u8; 64],
    pinned_public_key: &[u8; 32],
) -> Result<(), CryptoError> {
    ticket.validate()?;
    verify_exact(
        TICKET_DOMAIN,
        &ticket.encode_unsigned()?,
        &ticket.issuer_public_key_sha256,
        &ticket.detached_signature_sha256,
        signature_bytes,
        pinned_public_key,
    )
}

pub(crate) fn verify_transition(
    transition: &Transition,
    signature_bytes: &[u8; 64],
    pinned_public_key: &[u8; 32],
) -> Result<(), CryptoError> {
    transition.validate()?;
    verify_exact(
        transition.domain(),
        &transition.encode_unsigned()?,
        transition.issuer_public_key_sha256(),
        transition.detached_signature_sha256(),
        signature_bytes,
        pinned_public_key,
    )
}

fn verify_exact(
    domain: &str,
    canonical_unsigned: &[u8],
    issuer_public_key_sha256: &str,
    detached_signature_sha256: &str,
    signature_bytes: &[u8; 64],
    pinned_public_key: &[u8; 32],
) -> Result<(), CryptoError> {
    if issuer_public_key_sha256 != sha256_hex(pinned_public_key) {
        return Err(CryptoError::KeyPin);
    }
    if detached_signature_sha256 != sha256_hex(signature_bytes) {
        return Err(CryptoError::SignatureDigest);
    }
    let verifying_key =
        VerifyingKey::from_bytes(pinned_public_key).map_err(|_| CryptoError::Signature)?;
    let signature = Signature::from_bytes(signature_bytes);
    verifying_key
        .verify_strict(&preimage(domain, canonical_unsigned), &signature)
        .map_err(|_| CryptoError::Signature)
}

pub(crate) trait RecordSigner {
    fn public_key_bytes(&self) -> [u8; 32];
    fn sign_approval_grant(&self, grant: &ApprovalGrant) -> Result<[u8; 64], CryptoError>;
    fn sign_execution_ticket(&self, ticket: &ExecutionTicket) -> Result<[u8; 64], CryptoError>;
    fn sign_candidate_registered_transition(
        &self,
        transition: &CandidateRegisteredTransition,
    ) -> Result<[u8; 64], CryptoError>;
    fn sign_approved_transition(
        &self,
        transition: &ApprovedTransition,
    ) -> Result<[u8; 64], CryptoError>;
    fn sign_consumed_transition(
        &self,
        transition: &ConsumedTransition,
    ) -> Result<[u8; 64], CryptoError>;
    fn sign_candidate_expired_transition(
        &self,
        transition: &CandidateExpiredTransition,
    ) -> Result<[u8; 64], CryptoError>;
    fn sign_approval_expired_transition(
        &self,
        transition: &ApprovalExpiredTransition,
    ) -> Result<[u8; 64], CryptoError>;
}

#[cfg(test)]
pub(crate) struct SyntheticRecordSigner(ed25519_dalek::SigningKey);

#[cfg(test)]
impl SyntheticRecordSigner {
    pub(crate) fn from_seed(seed: [u8; 32]) -> Self {
        Self(ed25519_dalek::SigningKey::from_bytes(&seed))
    }
}

#[cfg(test)]
impl RecordSigner for SyntheticRecordSigner {
    fn public_key_bytes(&self) -> [u8; 32] {
        self.0.verifying_key().to_bytes()
    }

    fn sign_approval_grant(&self, grant: &ApprovalGrant) -> Result<[u8; 64], CryptoError> {
        use ed25519_dalek::Signer as _;
        Ok(self
            .0
            .sign(&preimage(GRANT_DOMAIN, &grant.encode_unsigned()?))
            .to_bytes())
    }

    fn sign_execution_ticket(&self, ticket: &ExecutionTicket) -> Result<[u8; 64], CryptoError> {
        use ed25519_dalek::Signer as _;
        Ok(self
            .0
            .sign(&preimage(TICKET_DOMAIN, &ticket.encode_unsigned()?))
            .to_bytes())
    }

    fn sign_candidate_registered_transition(
        &self,
        transition: &CandidateRegisteredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.sign_test_transition(&Transition::CandidateRegistered(transition.clone()))
    }

    fn sign_approved_transition(
        &self,
        transition: &ApprovedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.sign_test_transition(&Transition::Approved(transition.clone()))
    }

    fn sign_consumed_transition(
        &self,
        transition: &ConsumedTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.sign_test_transition(&Transition::Consumed(transition.clone()))
    }

    fn sign_candidate_expired_transition(
        &self,
        transition: &CandidateExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.sign_test_transition(&Transition::CandidateExpired(transition.clone()))
    }

    fn sign_approval_expired_transition(
        &self,
        transition: &ApprovalExpiredTransition,
    ) -> Result<[u8; 64], CryptoError> {
        self.sign_test_transition(&Transition::ApprovalExpired(transition.clone()))
    }
}

#[cfg(test)]
impl SyntheticRecordSigner {
    fn sign_test_transition(&self, transition: &Transition) -> Result<[u8; 64], CryptoError> {
        use ed25519_dalek::Signer as _;
        Ok(self
            .0
            .sign(&preimage(
                transition.domain(),
                &transition.encode_unsigned()?,
            ))
            .to_bytes())
    }
}
