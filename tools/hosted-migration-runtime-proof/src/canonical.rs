use serde::Serialize;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Digest32([u8; 32]);

impl Digest32 {
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub(crate) fn parse_hex(value: &str) -> Result<Self, CanonicalRefusal> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(CanonicalRefusal::InvalidDigest);
        }
        let bytes = hex::decode(value).map_err(|_| CanonicalRefusal::InvalidDigest)?;
        let mut digest = [0_u8; 32];
        digest.copy_from_slice(&bytes);
        Ok(Self(digest))
    }

    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn to_hex(self) -> String {
        hex::encode(self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanonicalRefusal {
    Encode,
    InvalidDigest,
}

pub(crate) fn sha256(bytes: &[u8]) -> Digest32 {
    Digest32::from_bytes(Sha256::digest(bytes).into())
}

pub(crate) fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, CanonicalRefusal> {
    let mut bytes = serde_json::to_string_pretty(value)
        .map_err(|_| CanonicalRefusal::Encode)?
        .into_bytes();
    bytes.push(b'\n');
    Ok(bytes)
}

pub(crate) fn now_utc_milliseconds() -> Result<String, CanonicalRefusal> {
    let now = OffsetDateTime::now_utc();
    let month = u8::from(now.month());
    Ok(format!(
        "{:04}-{month:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond(),
    ))
}

#[cfg(test)]
mod tests {
    use serde::Serialize;

    use super::*;

    #[derive(Serialize)]
    struct Fixture<'a> {
        schema: &'a str,
        count: u8,
    }

    #[test]
    fn canonical_json_has_two_spaces_and_one_terminal_line_feed() {
        let bytes = canonical_json(&Fixture {
            schema: "fixture.v1",
            count: 2,
        })
        .expect("canonical fixture");
        assert_eq!(
            bytes,
            b"{\n  \"schema\": \"fixture.v1\",\n  \"count\": 2\n}\n"
        );
    }

    #[test]
    fn digest_hex_is_strict_lowercase() {
        let exact = "00".repeat(32);
        assert_eq!(Digest32::parse_hex(&exact).expect("digest").to_hex(), exact);
        assert_eq!(
            Digest32::parse_hex(&"AA".repeat(32)),
            Err(CanonicalRefusal::InvalidDigest)
        );
    }

    #[test]
    fn acquired_timestamp_is_fixed_utc_millisecond_form() {
        let timestamp = now_utc_milliseconds().expect("UTC timestamp");
        assert_eq!(timestamp.len(), 24);
        assert_eq!(timestamp.as_bytes().get(4), Some(&b'-'));
        assert_eq!(timestamp.as_bytes().get(7), Some(&b'-'));
        assert_eq!(timestamp.as_bytes().get(10), Some(&b'T'));
        assert_eq!(timestamp.as_bytes().get(19), Some(&b'.'));
        assert!(timestamp.ends_with('Z'));
    }
}
