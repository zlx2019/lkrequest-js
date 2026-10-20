//! Request options to upstream's `RequestBuilder`, and the exchange that produces an outcome.
//!
//! Option handling follows `apply_request_options` in lkrequest-py. Bodies arrive already
//! normalized by the facade (fetch body-extraction rules).

use std::time::Instant;

use lkrequest::Session;
use lkrequest::diagnostics::capture_request_diagnostics;
use lkrequest::session::RequestBuilder;
use napi_derive::napi;

use crate::bridge::buffer::JsBytes;
use crate::bridge::cancel::{CancelToken, until_cancelled};
use crate::bridge::stream::{PullFn, PullStream};
use crate::error::{NativeError, invalid_arg};
use crate::multipart::{NativePart, to_multipart};
use crate::protocol::{self, NativePriority, NativeProtocolPolicy};
use crate::response::NativeResponse;
use crate::types::{accept_encoding, duration_from_ms, pairs, str_refs, usize_from};

/// Request options, flattened by the facade. Pairs are flat `[name, value, ...]` lists.
#[napi(object, object_to_js = false)]
pub struct NativeRequest {
    /// HTTP method, already upper-cased where the facade normalizes it.
    pub method: String,
    /// Absolute URL (the facade has already applied `baseUrl`).
    pub url: String,
    /// Request headers in send order.
    pub headers: Option<Vec<String>>,
    /// Query parameters appended to the URL.
    pub query: Option<Vec<String>>,
    /// Cookies merged with the session's cookie jar.
    pub cookies: Option<Vec<String>>,
    /// Cookies that replace jar cookies of the same name for this request.
    pub cookie_override: Option<Vec<String>>,
    /// Total time limit for this request, in milliseconds.
    pub timeout: Option<f64>,
    /// Token for `Authorization: Bearer`.
    pub bearer_auth: Option<String>,
    /// User name for `Authorization: Basic`.
    pub basic_auth_user: Option<String>,
    /// Password for `Authorization: Basic`.
    pub basic_auth_password: Option<String>,
    /// `false` keeps the body compressed as received.
    pub decompress: Option<bool>,
    /// Content codings to advertise for this request.
    pub accept_encoding: Option<Vec<String>>,
    /// Header order for this request, overriding the session's.
    pub header_order: Option<Vec<String>>,
    /// Cookie order for this request, overriding the session's.
    pub cookie_order: Option<Vec<String>>,
    /// Header order for this request over HTTP/3, overriding the session's.
    pub h3_header_order: Option<Vec<String>>,
    /// Request priority (RFC 9218).
    pub priority: Option<NativePriority>,
    /// Weight byte of the HTTP/2 HEADERS priority (0 to 255, the weight minus one).
    pub h2_priority_weight: Option<u32>,
    /// HTTP version preference for this request.
    pub preferred_http_version: Option<String>,
    /// Whether the request may be replayed (0-RTT, retries).
    pub idempotency: Option<String>,
    /// Protocol policy for this request: a preset, adjusted axis by axis.
    pub protocol_policy: Option<NativeProtocolPolicy>,
    /// HTTP/2 versus HTTP/3 intent for this request.
    pub http_intent: Option<String>,
    /// Proxy URL for this request, overriding the session's.
    pub proxy: Option<String>,
}

/// A request body; exactly one of `bytes`, `parts` and `pull` is set.
#[napi(object, object_to_js = false)]
pub struct NativeBody {
    /// A body held in memory.
    #[napi(ts_type = "Uint8Array")]
    pub bytes: Option<JsBytes>,
    /// `multipart/form-data` parts; upstream encodes them with a browser-style boundary.
    pub parts: Option<Vec<NativePart>>,
    /// Streaming body: resolves with the next chunk, or `null` at the end.
    #[napi(ts_type = "() => Promise<Uint8Array | null>")]
    pub pull: Option<PullFn>,
    /// Exact length of a streaming body; without it HTTP/1.1 uses chunked framing.
    pub length: Option<f64>,
}

/// The result of one request, as the facade receives it.
#[napi(object, object_from_js = false)]
pub struct NativeOutcome {
    /// Set when the exchange produced a response.
    pub response: Option<NativeResponse>,
    /// Set when the request failed.
    pub error: Option<NativeError>,
}

impl NativeOutcome {
    /// An outcome carrying an error.
    fn failed(error: NativeError) -> Self {
        Self {
            response: None,
            error: Some(error),
        }
    }
}

/// Turns the facade's options into an upstream request, validating them synchronously.
pub(crate) fn prepare(
    session: &Session,
    request: NativeRequest,
    body: Option<NativeBody>,
) -> napi::Result<RequestBuilder> {
    let method = http::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| invalid_arg(format!("invalid HTTP method {:?}", request.method)))?;
    let mut builder = session.request(method, &request.url);
    if let Some(headers) = &request.headers {
        builder = with_headers(builder, &pairs(headers, "headers")?);
    }
    if let Some(query) = &request.query {
        builder = builder.query(&pairs(query, "params")?);
    }
    if let Some(cookies) = &request.cookies {
        for (name, value) in pairs(cookies, "cookies")? {
            builder = builder.cookie(name, value);
        }
    }
    if let Some(cookies) = &request.cookie_override {
        for (name, value) in pairs(cookies, "cookieOverride")? {
            builder = builder.cookie_override(name, value);
        }
    }
    if let Some(token) = &request.bearer_auth {
        builder = builder.bearer_auth(token);
    }
    if let Some(user) = &request.basic_auth_user {
        builder = builder.basic_auth(user, request.basic_auth_password.as_deref());
    }
    if let Some(ms) = request.timeout {
        builder = builder.timeout(duration_from_ms(ms, "timeout")?);
    }
    if request.decompress == Some(false) {
        builder = builder.no_auto_decompress();
    }
    if let Some(names) = &request.accept_encoding {
        builder = builder.accept_encoding(accept_encoding(names)?);
    }
    if let Some(order) = &request.header_order {
        builder = builder.header_order(str_refs(order));
    }
    if let Some(order) = &request.cookie_order {
        builder = builder.cookie_order(str_refs(order));
    }
    builder = apply_protocol_options(builder, session, &request)?;
    match body {
        Some(body) => attach_body(builder, body),
        None => Ok(builder),
    }
}

/// Sets the request's headers through one map, so a name given more than once sends each of
/// its values (upstream's `header()` would keep only the last).
///
/// Names keep the order they first appear in, and the values of a name go out together. A
/// pair whose name or value is not valid HTTP is skipped, as `header()` skips it.
fn with_headers(builder: RequestBuilder, pairs: &[(&str, &str)]) -> RequestBuilder {
    let mut map = http::HeaderMap::new();
    let mut order = Vec::new();
    for &(name, value) in pairs {
        let (Ok(header), Ok(value)) = (
            http::HeaderName::from_bytes(name.as_bytes()),
            http::HeaderValue::from_str(value),
        ) else {
            continue;
        };
        if !map.contains_key(&header) {
            order.push(name);
        }
        map.append(header, value);
    }
    builder.headers_with_order(map, &order)
}

/// Applies the per-request protocol options, in lkrequest-py's order.
fn apply_protocol_options(
    mut builder: RequestBuilder,
    session: &Session,
    request: &NativeRequest,
) -> napi::Result<RequestBuilder> {
    if let Some(priority) = &request.priority {
        builder = builder.priority(protocol::priority(priority)?);
    }
    if let Some(weight) = request.h2_priority_weight {
        let weight = u8::try_from(weight)
            .map_err(|_| invalid_arg("h2PriorityWeight must be between 0 and 255"))?;
        builder = builder.h2_priority_weight(weight);
    }
    // An explicit `auto` here overrides a version the session forces.
    if let Some(name) = &request.preferred_http_version {
        builder = builder.preferred_http_version(protocol::preferred_http_version(name)?);
    }
    if let Some(name) = &request.idempotency {
        builder = builder.idempotency(protocol::idempotency(name)?);
    }
    if let Some(order) = &request.h3_header_order {
        builder = builder.h3_header_order(str_refs(order));
    }
    if let Some(spec) = &request.protocol_policy {
        let policy = protocol::protocol_policy(spec, session.protocol_policy())?;
        builder = builder.protocol_policy(policy);
    }
    if let Some(name) = &request.http_intent {
        builder = builder.http_intent(protocol::http_intent(name)?);
    }
    if let Some(url) = &request.proxy {
        // Checked here so an unparsable proxy URL throws at once, like every other invalid
        // option; upstream would only fail the request once it is sent.
        lkrequest::proxy::ProxyConfig::parse(url)
            .map_err(|err| invalid_arg(format!("invalid proxy {url:?}: {err}")))?;
        builder = builder.proxy(url);
    }
    Ok(builder)
}

/// Attaches whichever body variant the facade sent.
fn attach_body(builder: RequestBuilder, body: NativeBody) -> napi::Result<RequestBuilder> {
    match (body.bytes, body.parts, body.pull) {
        (Some(bytes), None, None) => Ok(builder.body(bytes.0)),
        (None, Some(parts), None) => Ok(builder.multipart(to_multipart(parts)?)),
        (None, None, Some(pull)) => {
            let length = body
                .length
                .map(|length| usize_from(length, "contentLength").map(|length| length as u64))
                .transpose()?;
            Ok(builder.body_stream(PullStream::new(pull), length))
        }
        (None, None, None) => Ok(builder),
        _ => Err(invalid_arg(
            "a request body must be exactly one of bytes, parts or pull",
        )),
    }
}

/// Sends the request and describes how it ended. Never fails: errors become outcomes.
///
/// Logs the same events as lkrequest-py's `execute_request`; `method` and `url` only label
/// them.
pub(crate) async fn send(
    builder: RequestBuilder,
    cancel: Option<&CancelToken>,
    method: &str,
    url: &str,
) -> NativeOutcome {
    tracing::debug!(method, url, "sending request");
    let started = Instant::now();
    let exchange = capture_request_diagnostics(builder.send());
    let Some((result, diagnostics)) = until_cancelled(cancel, exchange).await else {
        tracing::debug!(method, url, "request aborted");
        return NativeOutcome::failed(NativeError::aborted());
    };
    let elapsed = started.elapsed();
    let elapsed_ms = elapsed.as_secs_f64() * 1000.0;
    match result {
        Ok(response) => {
            tracing::debug!(
                method,
                url = response.url(),
                status = response.status().as_u16(),
                elapsed_ms,
                body_bytes = response.bytes().len(),
                "response received"
            );
            NativeOutcome {
                response: Some(NativeResponse::new(response, elapsed, diagnostics)),
                error: None,
            }
        }
        Err(err) => {
            tracing::error!(method, url, elapsed_ms, error = %err, "request failed");
            NativeOutcome::failed(NativeError::from_upstream(&err))
        }
    }
}
