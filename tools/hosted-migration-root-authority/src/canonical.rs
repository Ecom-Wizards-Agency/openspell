//! Exact canonical JSON encoding and bounded typed decoding.

use serde::de::DeserializeOwned;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) const MAX_CANONICAL_BYTES: usize = 16 * 1024;
const MIN_YEAR: i32 = 2020;
const MAX_YEAR_EXCLUSIVE: i32 = 2100;

#[derive(Clone, Copy)]
pub(crate) enum FieldValue<'a> {
    String(&'a str),
    Integer(u64),
    Boolean(bool),
}

fn quoted(value: &str) -> Result<String, CanonicalError> {
    serde_json::to_string(value).map_err(|_| CanonicalError::Encoding)
}

pub(crate) fn object(fields: &[(&str, FieldValue<'_>)]) -> Result<Vec<u8>, CanonicalError> {
    let mut output = String::from("{\n");
    for (index, (key, value)) in fields.iter().enumerate() {
        output.push_str("  ");
        output.push_str(&quoted(key)?);
        output.push_str(": ");
        match value {
            FieldValue::String(value) => output.push_str(&quoted(value)?),
            FieldValue::Integer(value) => output.push_str(&value.to_string()),
            FieldValue::Boolean(value) => output.push_str(if *value { "true" } else { "false" }),
        }
        if index + 1 != fields.len() {
            output.push(',');
        }
        output.push('\n');
    }
    output.push_str("}\n");
    if output.len() > MAX_CANONICAL_BYTES {
        return Err(CanonicalError::Limit);
    }
    Ok(output.into_bytes())
}

pub(crate) fn decode_exact<T>(
    input: &[u8],
    encode: impl FnOnce(&T) -> Result<Vec<u8>, CanonicalError>,
) -> Result<T, CanonicalError>
where
    T: DeserializeOwned,
{
    if input.is_empty() || input.len() > MAX_CANONICAL_BYTES {
        return Err(CanonicalError::Limit);
    }
    let parsed: T = serde_json::from_slice(input).map_err(|_| CanonicalError::Decoding)?;
    let canonical = encode(&parsed)?;
    if input != canonical {
        return Err(CanonicalError::NonCanonical);
    }
    Ok(parsed)
}

pub(crate) fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

pub(crate) fn validate_whole_timestamp(value: &str) -> Result<OffsetDateTime, CanonicalError> {
    validate_timestamp_shape(value, false)
}

pub(crate) fn validate_millisecond_timestamp(
    value: &str,
) -> Result<OffsetDateTime, CanonicalError> {
    validate_timestamp_shape(value, true)
}

pub(crate) fn validate_derived_timestamp(value: &str) -> Result<OffsetDateTime, CanonicalError> {
    match value.len() {
        20 => validate_whole_timestamp(value),
        24 => validate_millisecond_timestamp(value),
        _ => Err(CanonicalError::Timestamp),
    }
}

fn validate_timestamp_shape(
    value: &str,
    milliseconds: bool,
) -> Result<OffsetDateTime, CanonicalError> {
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
        return Err(CanonicalError::Timestamp);
    }
    for (index, byte) in bytes.iter().enumerate() {
        let punctuation = matches!(index, 4 | 7 | 10 | 13 | 16)
            || index + 1 == bytes.len()
            || (milliseconds && index == 19);
        if !punctuation && !byte.is_ascii_digit() {
            return Err(CanonicalError::Timestamp);
        }
    }
    let parsed = OffsetDateTime::parse(value, &Rfc3339).map_err(|_| CanonicalError::Timestamp)?;
    if parsed.year() < MIN_YEAR || parsed.year() >= MAX_YEAR_EXCLUSIVE {
        return Err(CanonicalError::Timestamp);
    }
    Ok(parsed)
}

pub(crate) fn select_minimum<'a>(
    candidates: &'a [(&'a str, OffsetDateTime)],
) -> Result<&'a str, CanonicalError> {
    let (mut selected_text, mut selected_time) =
        *candidates.first().ok_or(CanonicalError::Timestamp)?;
    for &(text, instant) in &candidates[1..] {
        if instant < selected_time {
            selected_text = text;
            selected_time = instant;
        }
    }
    Ok(selected_text)
}

pub(crate) fn add_whole_seconds(
    instant: OffsetDateTime,
    seconds: i64,
) -> Result<(String, OffsetDateTime), CanonicalError> {
    let derived = instant
        .checked_add(time::Duration::seconds(seconds))
        .ok_or(CanonicalError::Timestamp)?;
    let mut rendered = derived
        .format(&Rfc3339)
        .map_err(|_| CanonicalError::Timestamp)?;
    if rendered.ends_with(".000Z") {
        rendered.truncate(rendered.len() - 5);
        rendered.push('Z');
    }
    validate_whole_timestamp(&rendered)?;
    Ok((rendered, derived))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CanonicalError {
    Decoding,
    Encoding,
    Limit,
    NonCanonical,
    Timestamp,
}
