//! Conversions shared by the option parsers.
//!
//! The TypeScript facade validates and normalizes public options first; these checks are the
//! native layer's own guard and report through [`invalid_arg`].

use std::time::Duration;

use lkrequest::AcceptEncoding;

use crate::error::invalid_arg;

/// A millisecond count from JavaScript as a `Duration`.
pub(crate) fn duration_from_ms(ms: f64, name: &str) -> napi::Result<Duration> {
    Duration::try_from_secs_f64(ms / 1000.0).map_err(|_| {
        invalid_arg(format!(
            "{name} must be a non-negative, finite number of milliseconds"
        ))
    })
}

/// A size or count from JavaScript as a `usize`.
pub(crate) fn usize_from(value: f64, name: &str) -> napi::Result<usize> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= usize::MAX as f64 {
        Ok(value as usize)
    } else {
        Err(invalid_arg(format!(
            "{name} must be a non-negative integer"
        )))
    }
}

/// Splits a flat `[name, value, name, value, ...]` list into pairs.
///
/// Pairs travel flat because that converts faster than an array of tuples; the facade always
/// sends an even number of items.
pub(crate) fn pairs<'a>(flat: &'a [String], name: &str) -> napi::Result<Vec<(&'a str, &'a str)>> {
    let (pairs, rest) = flat.as_chunks::<2>();
    if !rest.is_empty() {
        return Err(invalid_arg(format!("{name} must hold name/value pairs")));
    }
    Ok(pairs
        .iter()
        .map(|[name, value]| (name.as_str(), value.as_str()))
        .collect())
}

/// Borrowed views of owned strings, the shape upstream's ordering setters take.
pub(crate) fn str_refs(items: &[String]) -> Vec<&str> {
    items.iter().map(String::as_str).collect()
}

/// Content codings named as in `Accept-Encoding` (`gzip`, `br`, `deflate`, `zstd`).
pub(crate) fn accept_encoding(names: &[String]) -> napi::Result<AcceptEncoding> {
    names.iter().try_fold(AcceptEncoding::empty(), |all, name| {
        let coding = match name.as_str() {
            "gzip" => AcceptEncoding::GZIP,
            "br" => AcceptEncoding::BR,
            "deflate" => AcceptEncoding::DEFLATE,
            "zstd" => AcceptEncoding::ZSTD,
            other => {
                return Err(invalid_arg(format!(
                    "unknown content coding {other:?}; expected gzip, br, deflate or zstd"
                )));
            }
        };
        Ok(all | coding)
    })
}
