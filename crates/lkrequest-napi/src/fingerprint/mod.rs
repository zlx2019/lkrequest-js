//! Fingerprint profiles: TLS, HTTP/2 and TCP, each a native class the facade wraps, and a
//! parser for captured HTTP/3 control streams.
//!
//! Ported from lkrequest-py's `src/fingerprint.rs`. Python builds every sub-structure through
//! its own class; here they are plain objects converted by napi, so only the top-level
//! profiles are classes.

pub(crate) mod h2;
pub(crate) mod h3;
pub(crate) mod tcp;
pub(crate) mod tls;

use crate::error::invalid_arg;

/// A table of presets: each name with the upstream function that builds it.
pub(crate) type Presets<T> = [(&'static str, fn() -> T)];

/// Builds the preset `name` from `table`; `kind` names the profile type in the error.
pub(crate) fn lookup<T>(table: &Presets<T>, kind: &str, name: &str) -> napi::Result<T> {
    table
        .iter()
        .find(|(preset, _)| *preset == name)
        .map(|(_, build)| build())
        .ok_or_else(|| {
            invalid_arg(format!(
                "unknown {kind} preset {name:?}; expected one of {}",
                names(table).join(", ")
            ))
        })
}

/// The names in a preset table, in order.
pub(crate) fn names<T>(table: &Presets<T>) -> Vec<&'static str> {
    table.iter().map(|(name, _)| *name).collect()
}

/// A list of JavaScript numbers as `u16` values, rejecting anything out of range.
fn u16_list(values: &[u32], name: &str) -> napi::Result<Vec<u16>> {
    values
        .iter()
        .map(|&value| {
            u16::try_from(value)
                .map_err(|_| invalid_arg(format!("{name} values must be between 0 and 65535")))
        })
        .collect()
}

/// A list of JavaScript numbers as `u8` values, rejecting anything out of range.
fn u8_list(values: &[u32], name: &str) -> napi::Result<Vec<u8>> {
    values
        .iter()
        .map(|&value| {
            u8::try_from(value)
                .map_err(|_| invalid_arg(format!("{name} values must be between 0 and 255")))
        })
        .collect()
}
