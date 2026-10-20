//! The native session: redirect, encoding, protocol and connection settings, the request
//! entry, and the connection pool operations.

use lkrequest::session::SessionBuilder;
use lkrequest::{Client, PreferredHttpVersion, RedirectPolicy, Session};
use napi::Env;
use napi::bindgen_prelude::{AsyncBlock, AsyncBlockBuilder};
use napi_derive::napi;

use crate::bridge::buffer::JsBytes;
use crate::bridge::cancel::AbortHandle;
use crate::bridge::inflight::{Delivered, InFlightGuard};
use crate::error::NativeError;
use crate::hsts::NativeHsts;
use crate::network_partition::{NativePartitionContext, partition_context};
use crate::protocol::{self, NativeBrokenQuicPolicy, NativeProtocolPolicy};
use crate::proxy::NativeProxyConfig;
use crate::request::{self, NativeBody, NativeOutcome, NativeRequest};
use crate::retry::{self, NativeRetryStrategy, RetryFn};
use crate::streaming::{self, NativeStreamOutcome};
use crate::types::{accept_encoding, duration_from_ms, str_refs, usize_from};
use crate::websocket::{self, NativeWebSocketOptions, NativeWebSocketOutcome};

/// Session options, flattened by the facade. Durations are in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeSessionOptions {
    /// `false` returns 3xx responses as they are instead of following them.
    pub follow_redirects: Option<bool>,
    /// Redirects to follow before failing with `TooManyRedirectsError` (default 10).
    pub max_redirects: Option<u32>,
    /// Content codings to advertise in `Accept-Encoding`.
    pub accept_encoding: Option<Vec<String>>,
    /// Upper bound on connections this session keeps open.
    pub max_connections: Option<f64>,
    /// How long an idle pooled connection is kept.
    pub idle_timeout: Option<f64>,
    /// Header order for HTTP/1.1 and HTTP/2 requests, overriding the client's.
    pub header_order: Option<Vec<String>>,
    /// Order of cookies in the `Cookie` header, overriding the client's.
    pub cookie_order: Option<Vec<String>>,
    /// Header order for HTTP/3 requests, overriding the client's.
    pub h3_header_order: Option<Vec<String>>,
    /// HTTP version preference: `auto`, `http1_only`, `http2_only`, `http3_only` or
    /// `http3_with_fallback`.
    pub preferred_http_version: Option<String>,
    /// Protocol policy, overriding the client's: a preset, adjusted axis by axis.
    pub protocol_policy: Option<NativeProtocolPolicy>,
    /// HTTP/2 versus HTTP/3 intent, applied on top of the protocol policy.
    pub http_intent: Option<String>,
    /// How an origin whose QUIC connection failed is avoided.
    pub broken_quic_policy: Option<NativeBrokenQuicPolicy>,
    /// HTTP/3 protocol-error retries: `safe` (default) or `chrome_155_protocol_errors`.
    pub h3_retry_mode: Option<String>,
    /// Refuse `http://` URLs.
    pub https_only: Option<bool>,
    /// Browsing context the session-ticket cache is partitioned by.
    pub network_partition_context: Option<NativePartitionContext>,
    /// Encrypted Client Hello configuration list, overriding the client's.
    #[napi(ts_type = "Uint8Array")]
    pub ech: Option<JsBytes>,
    /// A built-in retry strategy.
    pub retry: Option<NativeRetryStrategy>,
    /// A JavaScript retry policy, resolving with a delay in milliseconds or `null`.
    #[napi(
        ts_type = "(attempt: number, error: NativeError | null, status: number | null) => Promise<number | null>"
    )]
    pub retry_fn: Option<RetryFn>,
}

/// Connection pool statistics of a session.
#[napi(object, object_from_js = false)]
pub struct NativePoolStats {
    /// Idle HTTP/1.1 connections.
    pub h1_connections: u32,
    /// HTTP/2 connections.
    pub h2_connections: u32,
    /// HTTP/3 connections.
    pub h3_connections: u32,
    /// Connections counted against the limit, checked-out ones included.
    pub total: u32,
    /// The connection limit; `Infinity` when there is none.
    pub max_total: f64,
    /// Whether the limit is reached.
    pub at_capacity: bool,
}

/// The outcome of preconnecting to one URL.
#[napi(object, object_from_js = false)]
pub struct NativePreconnectResult {
    /// The URL as given.
    pub url: String,
    /// Set when the connection could not be established.
    pub error: Option<NativeError>,
}

/// The outcome of prefetching one URL.
#[napi(object, object_from_js = false)]
pub struct NativePrefetchResult {
    /// The URL as given.
    pub url: String,
    /// Whether a connection was established.
    pub success: bool,
    /// Time spent, in milliseconds.
    pub duration: f64,
    /// Why it failed, when it did.
    pub error: Option<String>,
}

/// The native session behind the public `Session`.
#[napi]
pub struct NativeSession {
    pub(crate) inner: Session,
}

impl NativeSession {
    /// Builds a session of `client`; invalid options throw synchronously.
    pub(crate) fn new(
        client: &Client,
        options: Option<NativeSessionOptions>,
        hsts: Option<&NativeHsts>,
        proxy: Option<&NativeProxyConfig>,
    ) -> napi::Result<Self> {
        let mut builder = client.session();
        if let Some(proxy) = proxy {
            builder = builder.proxy_config(proxy.inner.clone());
        }
        if let Some(hsts) = hsts {
            builder = builder.hsts_policy(hsts.shared());
        }
        if let Some(options) = options {
            if options.follow_redirects == Some(false) {
                builder = builder.redirect_policy(RedirectPolicy::None);
            } else if let Some(max) = options.max_redirects {
                builder = builder.max_redirects(max);
            }
            if let Some(names) = &options.accept_encoding {
                builder = builder.default_accept_encoding(accept_encoding(names)?);
            }
            if let Some(n) = options.max_connections {
                builder = builder.max_connections(usize_from(n, "maxConnections")?);
            }
            if let Some(ms) = options.idle_timeout {
                builder = builder.idle_timeout(duration_from_ms(ms, "idleTimeout")?);
            }
            if let Some(order) = &options.header_order {
                builder = builder.header_order(str_refs(order));
            }
            if let Some(order) = &options.cookie_order {
                builder = builder.cookie_order(str_refs(order));
            }
            builder = configure_protocols(builder, client, &options)?;
            builder = retry::configure(builder, options.retry.as_ref(), options.retry_fn)?;
        }
        Ok(Self {
            inner: builder.build(),
        })
    }
}

/// Applies the protocol, transport security and partitioning options, in lkrequest-py's order.
fn configure_protocols(
    mut builder: SessionBuilder,
    client: &Client,
    options: &NativeSessionOptions,
) -> napi::Result<SessionBuilder> {
    if let Some(name) = &options.preferred_http_version {
        // The session builder has no setter for `Auto`, which is its default.
        builder = match protocol::preferred_http_version(name)? {
            PreferredHttpVersion::Auto => builder,
            PreferredHttpVersion::Http1Only => builder.http1_only(),
            PreferredHttpVersion::Http2Only => builder.http2_only(),
            PreferredHttpVersion::Http3Only => builder.http3_only(),
            PreferredHttpVersion::Http3WithFallback => builder.http3_with_fallback(),
        };
    }
    if let Some(ech) = &options.ech {
        builder = builder.ech_config(ech.0.to_vec());
    }
    if let Some(spec) = &options.protocol_policy {
        let policy = protocol::protocol_policy(spec, client.protocol_policy())?;
        builder = builder.protocol_policy(policy);
    }
    if let Some(name) = &options.http_intent {
        builder = builder.http_intent(protocol::http_intent(name)?);
    }
    if let Some(spec) = &options.broken_quic_policy {
        builder = builder.broken_quic_policy(protocol::broken_quic_policy(spec)?);
    }
    if let Some(name) = &options.h3_retry_mode {
        builder = protocol::h3_retry_mode(builder, name)?;
    }
    if let Some(order) = &options.h3_header_order {
        builder = builder.h3_header_order(str_refs(order));
    }
    if let Some(https_only) = options.https_only {
        builder = builder.https_only(https_only);
    }
    if let Some(context) = &options.network_partition_context {
        builder = builder.network_partition_context(partition_context(context));
    }
    Ok(builder)
}

#[napi]
impl NativeSession {
    /// Sends a request. Resolves with `{ response }` or `{ error }` and never rejects for a
    /// request failure; invalid arguments throw synchronously.
    ///
    /// The request counts as in flight from this call until its result has been delivered.
    #[napi(ts_return_type = "Promise<NativeOutcome>")]
    pub fn request(
        &self,
        env: Env,
        request: NativeRequest,
        body: Option<NativeBody>,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<NativeOutcome>>> {
        let guard = InFlightGuard::register();
        let (method, url) = (request.method.clone(), request.url.clone());
        let builder = request::prepare(&self.inner, request, body)?;
        let token = abort.map(AbortHandle::token);
        let exchange = async move {
            let outcome = request::send(builder, token.as_deref(), &method, &url).await;
            Ok(Delivered::new(outcome, guard))
        };
        AsyncBlockBuilder::new(exchange).build(&env)
    }

    /// Sends a request and resolves once the response headers arrive, leaving the body to be
    /// read in chunks. Follows no redirect and applies no retry policy. Resolves with
    /// `{ response }` or `{ error }` and never rejects for a request failure.
    #[napi(ts_return_type = "Promise<NativeStreamOutcome>")]
    pub fn stream(
        &self,
        env: Env,
        request: NativeRequest,
        body: Option<NativeBody>,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<NativeStreamOutcome>>> {
        let guard = InFlightGuard::register();
        let (method, url) = (request.method.clone(), request.url.clone());
        let builder = request::prepare(&self.inner, request, body)?;
        let token = abort.map(AbortHandle::token);
        let exchange = async move {
            let outcome = streaming::send(builder, token.as_deref(), &method, &url).await;
            Ok(Delivered::new(outcome, guard))
        };
        AsyncBlockBuilder::new(exchange).build(&env)
    }

    /// Opens a WebSocket connection with the session's fingerprint, cookies and proxy.
    /// Resolves with `{ socket }` or `{ error }` and never rejects for a failed handshake.
    #[napi(ts_return_type = "Promise<NativeWebSocketOutcome>")]
    pub fn websocket(
        &self,
        env: Env,
        url: String,
        options: Option<NativeWebSocketOptions>,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<NativeWebSocketOutcome>>> {
        let options = options.unwrap_or(NativeWebSocketOptions {
            headers: None,
            protocols: None,
            extensions: None,
        });
        websocket::open(&env, self.inner.clone(), url, options, abort)
    }

    /// Statistics of the session's connection pool.
    #[napi]
    pub fn pool_stats(&self) -> NativePoolStats {
        let stats = self.inner.pool_stats();
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        NativePoolStats {
            h1_connections: count(stats.h1_connections),
            h2_connections: count(stats.h2_connections),
            h3_connections: count(stats.h3_connections),
            total: count(stats.total),
            max_total: match stats.max_total {
                usize::MAX => f64::INFINITY,
                n => n as f64,
            },
            at_capacity: stats.at_capacity,
        }
    }

    /// Closes every pooled connection. Their slots are released once the connections have
    /// shut down, shortly after this returns.
    #[napi]
    pub fn clear_pool(&self) {
        self.inner.pool_clear();
    }

    /// Opens a connection to `url` ahead of time. Resolves with `null`, or with the error that
    /// prevented the connection.
    #[napi(ts_return_type = "Promise<NativeError | null>")]
    pub fn preconnect(
        &self,
        env: Env,
        url: String,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        let guard = InFlightGuard::register();
        let session = self.inner.clone();
        let work = async move {
            let error = session.preconnect(&url).await.err();
            Ok(Delivered::new(
                error.as_ref().map(NativeError::from_upstream),
                guard,
            ))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }

    /// Opens connections to several URLs concurrently.
    #[napi(ts_return_type = "Promise<NativePreconnectResult[]>")]
    pub fn preconnect_many(
        &self,
        env: Env,
        urls: Vec<String>,
    ) -> napi::Result<AsyncBlock<Delivered<Vec<NativePreconnectResult>>>> {
        let guard = InFlightGuard::register();
        let session = self.inner.clone();
        let work = async move {
            let refs: Vec<&str> = urls.iter().map(String::as_str).collect();
            let results = session.preconnect_many(&refs).await;
            let results = urls
                .iter()
                .zip(results)
                .map(|(url, result)| NativePreconnectResult {
                    url: url.clone(),
                    error: result.err().as_ref().map(NativeError::from_upstream),
                })
                .collect();
            Ok(Delivered::new(results, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }

    /// Warms connections to several URLs with `HEAD` requests, concurrently.
    #[napi(ts_return_type = "Promise<NativePrefetchResult[]>")]
    pub fn prefetch(
        &self,
        env: Env,
        urls: Vec<String>,
    ) -> napi::Result<AsyncBlock<Delivered<Vec<NativePrefetchResult>>>> {
        let guard = InFlightGuard::register();
        let session = self.inner.clone();
        let work = async move {
            let refs: Vec<&str> = urls.iter().map(String::as_str).collect();
            let results = session
                .prefetch(&refs)
                .await
                .into_iter()
                .map(|result| NativePrefetchResult {
                    url: result.url,
                    success: result.success,
                    duration: result.duration.as_secs_f64() * 1000.0,
                    error: result.error,
                })
                .collect();
            Ok(Delivered::new(results, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }
}
