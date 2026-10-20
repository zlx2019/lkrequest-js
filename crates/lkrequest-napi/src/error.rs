//! Upstream errors as structured payloads for the TypeScript facade.
//!
//! A failed request does not reject: it resolves with `{ error: NativeError }` and the facade
//! throws the matching `src/errors.ts` subclass. The class mapping follows `to_py_err` in
//! lkrequest-py, keyed by `code`.

use lkrequest::error::{ConnectionPhase, Error};
use napi::Status;
use napi_derive::napi;

/// A request failure, ready to become an `Error` subclass in TypeScript.
#[napi(object, object_from_js = false)]
pub struct NativeError {
    /// Node-style error code that selects the subclass, for example `ERR_LK_TIMEOUT`.
    pub code: String,
    /// Upstream error variant in snake_case, for example `connection_closed`.
    pub kind: String,
    /// Human-readable description from upstream.
    pub message: String,
    /// Connection phase the failure happened in, for example `tls_handshake`.
    pub phase: Option<String>,
    /// Whether retrying the request could succeed.
    pub retryable: bool,
    /// Whether the request can be replayed without side effects on the server.
    pub safe_to_replay: bool,
    /// HTTP status, for status errors only.
    pub status: Option<u16>,
}

impl NativeError {
    /// Describes an upstream error.
    pub(crate) fn from_upstream(err: &Error) -> Self {
        // With `h3RetryMode`, upstream wraps HTTP/3 request errors in a retry context; the
        // class comes from the error inside it, as upstream's own predicates do.
        let (code, kind) = code_and_kind(err.unwrapped());
        let mut message = err.to_string();
        if err.is_address_family_mismatch() {
            message.push_str(" (excluded by the client's family setting)");
        }
        Self {
            code: code.to_owned(),
            kind: kind.to_owned(),
            message,
            phase: err.phase().map(|phase| phase_name(phase).to_owned()),
            retryable: err.is_retryable(),
            safe_to_replay: err.is_safe_to_replay(),
            status: err.status().map(|status| status.as_u16()),
        }
    }

    /// Describes an operation on a connection that is already closed.
    pub(crate) fn closed(message: &str) -> Self {
        Self {
            code: "ERR_LK_REQUEST".to_owned(),
            kind: "connection_closed".to_owned(),
            message: message.to_owned(),
            phase: None,
            retryable: false,
            safe_to_replay: false,
            status: None,
        }
    }

    /// Describes a request cancelled through its `AbortSignal`.
    pub(crate) fn aborted() -> Self {
        Self {
            code: "ABORT_ERR".to_owned(),
            kind: "aborted".to_owned(),
            message: "The operation was aborted".to_owned(),
            phase: None,
            retryable: false,
            safe_to_replay: false,
            status: None,
        }
    }
}

/// The error code (which selects the TypeScript class) and the variant name of `err`.
fn code_and_kind(err: &Error) -> (&'static str, &'static str) {
    match err {
        Error::Timeout { .. } => ("ERR_LK_TIMEOUT", "timeout"),
        Error::Connection(_) => ("ERR_LK_CONNECTION", "connection"),
        Error::Io(_) => ("ERR_LK_CONNECTION", "io"),
        Error::Tls(_) => ("ERR_LK_TLS", "tls"),
        Error::Proxy(_) => ("ERR_LK_PROXY", "proxy"),
        Error::Status { .. } => ("ERR_LK_HTTP_STATUS", "status"),
        Error::TooManyRedirects(_) => ("ERR_LK_TOO_MANY_REDIRECTS", "too_many_redirects"),
        Error::ResourceLimitExceeded(_) => ("ERR_LK_RESOURCE_LIMIT", "resource_limit_exceeded"),
        Error::InvalidConfig(_) => ("ERR_LK_INVALID_CONFIG", "invalid_config"),
        Error::Http(_) => ("ERR_LK_REQUEST", "http"),
        Error::Body(_) => ("ERR_LK_REQUEST", "body"),
        Error::H2(_) => ("ERR_LK_REQUEST", "h2"),
        Error::ConnectionClosed { .. } => ("ERR_LK_REQUEST", "connection_closed"),
        Error::Quic(_) => ("ERR_LK_REQUEST", "quic"),
        Error::QuicTransport(_) => ("ERR_LK_REQUEST", "quic_transport"),
        Error::QuicHandshake(_) => ("ERR_LK_REQUEST", "quic_handshake"),
        Error::H3(_) => ("ERR_LK_REQUEST", "h3"),
        Error::Http3Request(_) => ("ERR_LK_REQUEST", "http3_request"),
        Error::Pool(_) => ("ERR_LK_REQUEST", "pool"),
        Error::UrlParse(_) => ("ERR_LK_REQUEST", "url_parse"),
        // Upstream's error enum is non-exhaustive; new variants surface as plain request
        // errors until they get a dedicated mapping.
        _ => ("ERR_LK_REQUEST", "other"),
    }
}

/// The snake_case name of a connection phase.
fn phase_name(phase: ConnectionPhase) -> &'static str {
    match phase {
        ConnectionPhase::DnsResolution => "dns_resolution",
        ConnectionPhase::TcpConnect => "tcp_connect",
        ConnectionPhase::ProxyTunnel => "proxy_tunnel",
        ConnectionPhase::TlsHandshake => "tls_handshake",
        ConnectionPhase::H2Negotiation => "h2_negotiation",
        ConnectionPhase::H2cUpgrade => "h2c_upgrade",
        ConnectionPhase::QuicHandshake => "quic_handshake",
        ConnectionPhase::H3Negotiation => "h3_negotiation",
        ConnectionPhase::QuicFallback => "quic_fallback",
        ConnectionPhase::HttpRequest => "http_request",
    }
}

/// An invalid argument, thrown synchronously. The facade turns it into a `TypeError` with
/// code `ERR_LK_INVALID_CONFIG`.
pub(crate) fn invalid_arg(message: impl Into<String>) -> napi::Error {
    napi::Error::new(Status::InvalidArg, message.into())
}
