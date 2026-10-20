//! Upstream responses as plain objects for the facade's fetch-style `Response`.

use std::time::Duration;

use http::HeaderMap;
use lkrequest::diagnostics::RequestDiagnostics;
use lkrequest::{HttpVersion, RedirectRecord, Response};
use napi_derive::napi;

use crate::bridge::buffer::ExternalBytes;

/// A buffered response.
#[napi(object, object_from_js = false)]
pub struct NativeResponse {
    /// HTTP status code.
    pub status: u16,
    /// Canonical reason phrase of the status; upstream does not keep the one on the wire.
    pub status_text: String,
    /// Final URL, after redirects.
    pub url: String,
    /// `"1.0"`, `"1.1"`, `"2.0"`, `"3.0"`, or `""` when unknown (Node's `httpVersion` style).
    pub http_version: String,
    /// Headers as flat name/value pairs: lower-case names, duplicates kept, upstream order.
    pub headers: Vec<String>,
    /// Redirects followed before this response, oldest first.
    pub history: Vec<NativeRedirect>,
    /// Phase timings and transport details.
    pub diagnostics: NativeDiagnostics,
    /// Wall-clock time of the whole exchange, in milliseconds.
    pub elapsed: f64,
    /// Decompressed body, handed over without a copy.
    #[napi(ts_type = "Buffer")]
    pub body: ExternalBytes,
}

/// One redirect hop.
#[napi(object, object_from_js = false)]
pub struct NativeRedirect {
    /// URL that answered with the redirect.
    pub url: String,
    /// Redirect status code.
    pub status: u16,
    /// Headers of the redirect response, as flat name/value pairs.
    pub headers: Vec<String>,
    /// Absolute URL the redirect pointed to.
    pub location: String,
}

/// Per-request diagnostics; a phase is absent when it did not run (a reused connection skips
/// DNS, TCP and TLS).
#[napi(object, object_from_js = false)]
pub struct NativeDiagnostics {
    /// DNS resolution time, in milliseconds.
    pub dns_ms: Option<f64>,
    /// TCP connect time, in milliseconds.
    pub tcp_ms: Option<f64>,
    /// TLS handshake time, in milliseconds.
    pub tls_ms: Option<f64>,
    /// Time to the first response byte, in milliseconds.
    pub ttfb_ms: Option<f64>,
    /// Total time measured by upstream, in milliseconds.
    pub total_ms: Option<f64>,
    /// Remote `ip:port` the request was sent to.
    pub remote_addr: Option<String>,
    /// Negotiated application protocol, for example `h2`.
    pub protocol: Option<String>,
    /// Negotiated TLS cipher suite.
    pub cipher_suite: Option<String>,
}

impl NativeResponse {
    /// Converts an upstream response, moving its body out without a copy.
    pub(crate) fn new(
        response: Response,
        elapsed: Duration,
        diagnostics: RequestDiagnostics,
    ) -> Self {
        let status = response.status();
        Self {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or_default().to_owned(),
            url: response.url().to_owned(),
            http_version: version_name(response.version()).to_owned(),
            headers: flat_headers(response.headers()),
            history: response
                .redirect_history()
                .iter()
                .map(NativeRedirect::from)
                .collect(),
            diagnostics: NativeDiagnostics::from(diagnostics),
            elapsed: elapsed.as_secs_f64() * 1000.0,
            body: ExternalBytes(response.into_bytes()),
        }
    }
}

impl From<&RedirectRecord> for NativeRedirect {
    /// Copies one hop of the redirect chain.
    fn from(record: &RedirectRecord) -> Self {
        Self {
            url: record.url().to_owned(),
            status: record.status().as_u16(),
            headers: flat_headers(record.headers()),
            location: record.redirect_to().to_owned(),
        }
    }
}

impl From<RequestDiagnostics> for NativeDiagnostics {
    /// Converts millisecond counters to JavaScript numbers.
    fn from(diagnostics: RequestDiagnostics) -> Self {
        let ms = |value: Option<u64>| value.map(|ms| ms as f64);
        Self {
            dns_ms: ms(diagnostics.dns_ms),
            tcp_ms: ms(diagnostics.tcp_ms),
            tls_ms: ms(diagnostics.tls_ms),
            ttfb_ms: ms(diagnostics.ttfb_ms),
            total_ms: ms(diagnostics.total_ms),
            remote_addr: diagnostics.remote_addr,
            protocol: diagnostics.protocol,
            cipher_suite: diagnostics.cipher_suite,
        }
    }
}

/// Node's spelling of an HTTP version.
fn version_name(version: HttpVersion) -> &'static str {
    match version {
        HttpVersion::Http10 => "1.0",
        HttpVersion::Http11 => "1.1",
        HttpVersion::H2 => "2.0",
        HttpVersion::H3 => "3.0",
        HttpVersion::Unknown => "",
    }
}

/// Flattens a header map into name/value pairs.
///
/// Values are decoded as latin1, byte for byte, the way Node's `http` module does: a value
/// that is not valid UTF-8 survives instead of being dropped.
pub(crate) fn flat_headers(headers: &HeaderMap) -> Vec<String> {
    let mut flat = Vec::with_capacity(headers.len() * 2);
    for (name, value) in headers {
        flat.push(name.as_str().to_owned());
        flat.push(value.as_bytes().iter().copied().map(char::from).collect());
    }
    flat
}
