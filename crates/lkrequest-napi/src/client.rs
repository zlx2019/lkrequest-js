//! The native client: fingerprint, connection and TLS configuration shared by its sessions.
//!
//! Option handling follows `build_client` in lkrequest-py. The facade flattens the grouped
//! public options (`timeouts`, `limits`, `tls`, ...) into [`NativeClientOptions`].

use lkrequest::client::ClientBuilder;
use lkrequest::lkh2::profile::H2Profile;
use lkrequest::lktls::profile::TlsProfile;
use lkrequest::{
    Client, H2DataFramePolicy, ProtocolPolicy, QuicProfile, ResourceLimits, TcpFingerprint,
    TimeoutConfig,
};
use napi::bindgen_prelude::ClassInstance;
use napi_derive::napi;

use crate::bridge::buffer::JsBytes;
use crate::dns::{self, DnsOptions, NativeDialOverride};
use crate::error::invalid_arg;
use crate::fingerprint::h2::NativeH2Profile;
use crate::fingerprint::tcp::NativeTcpFingerprint;
use crate::fingerprint::tls::NativeTlsProfile;
use crate::hsts::NativeHsts;
use crate::keylog::{self, KeylogFn};
use crate::masque::{self, NativeMasqueOptions};
use crate::network_partition::{
    self, NativeResumptionPolicy, NativeSessionResumption, describe_resumption_policy,
};
use crate::protocol::NativeProtocolPolicy;
use crate::proxy::NativeProxyConfig;
use crate::quic::NativeQuicProfile;
use crate::randomize::{self, NativeRandomize};
use crate::resolver::{LookupHttpsFn, ResolveFn};
use crate::session::{NativeSession, NativeSessionOptions};
use crate::types::{duration_from_ms, pairs, str_refs, usize_from};
use crate::{preset, protocol};

/// Client options, flattened by the facade. Durations are in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeClientOptions {
    /// Browser preset name, see `listPresets()`.
    pub preset: Option<String>,
    /// Headers sent with every request, as flat name/value pairs.
    pub default_headers: Option<Vec<String>>,
    /// Header order for HTTP/1.1 and HTTP/2 requests.
    pub header_order: Option<Vec<String>>,
    /// Order of cookies in the `Cookie` header.
    pub cookie_order: Option<Vec<String>>,
    /// Header order for HTTP/3 requests.
    pub h3_header_order: Option<Vec<String>>,
    /// DNS resolution time limit.
    pub dns_timeout: Option<f64>,
    /// TCP connect time limit.
    pub tcp_connect_timeout: Option<f64>,
    /// TLS handshake time limit.
    pub tls_handshake_timeout: Option<f64>,
    /// Time-to-first-byte limit.
    pub ttfb_timeout: Option<f64>,
    /// Limit for the whole request, redirects included.
    pub total_timeout: Option<f64>,
    /// QUIC handshake time limit.
    pub quic_connect_timeout: Option<f64>,
    /// Largest accepted response body, in bytes.
    pub max_response_body_size: Option<f64>,
    /// Upper bound on connections per session.
    pub max_connections_per_session: Option<f64>,
    /// Upper bound on queued HTTP/2 requests per connection (unbounded when unset).
    pub max_pending_h2_requests: Option<f64>,
    /// Largest accepted number of response headers.
    pub max_header_count: Option<f64>,
    /// Largest accepted single response header, in bytes.
    pub max_header_size: Option<f64>,
    /// Largest accepted response header block, in bytes.
    pub max_headers_total_size: Option<f64>,
    /// Minimum transfer rate in bytes per second, measured over `minTransferRateWindow`.
    pub min_transfer_rate: Option<f64>,
    /// Window the minimum transfer rate is measured over.
    pub min_transfer_rate_window: Option<f64>,
    /// Ready HTTP/2 requests coalesced into one write turn.
    pub h2_dispatch_batch_size: Option<f64>,
    /// How outbound HTTP/2 DATA payloads are capped.
    pub h2_data_frame_policy: Option<NativeH2DataFramePolicy>,
    /// Retry over HTTP/1.1 when HTTP/2 negotiation fails.
    pub h2_fallback_h1: Option<bool>,
    /// Connect directly when the proxy cannot be reached.
    pub proxy_fallback_direct: Option<bool>,
    /// Retry once when a pooled connection turns out to be closed.
    pub retry_on_connection_close: Option<bool>,
    /// Extra trust anchors as PEM documents.
    #[napi(ts_type = "Uint8Array[]")]
    pub ca_pem: Option<Vec<JsBytes>>,
    /// Extra trust anchors as DER certificates.
    #[napi(ts_type = "Uint8Array[]")]
    pub ca_der: Option<Vec<JsBytes>>,
    /// Verify server certificates (default `true`).
    pub reject_unauthorized: Option<bool>,
    /// Trust the operating system's certificate store in addition to the bundled roots.
    pub use_native_certs: Option<bool>,
    /// Encrypted Client Hello configuration list.
    #[napi(ts_type = "Uint8Array")]
    pub ech: Option<JsBytes>,
    /// File to append TLS secrets to, in NSS key log format.
    pub keylog: Option<String>,
    /// A function called with each line of the key log, instead of a file.
    #[napi(ts_type = "(line: string) => void")]
    pub keylog_fn: Option<KeylogFn>,
    /// Treat a TLS connection closed without `close_notify` as an error.
    pub require_close_notify: Option<bool>,
    /// Whether TLS session tickets are cached and offered.
    pub tls_session_resumption_policy: Option<NativeResumptionPolicy>,
    /// How the session-ticket cache is partitioned by browsing context.
    pub tls_session_cache_partition_policy: Option<String>,
    /// Resumption modes the TLS profile advertises.
    pub session_resumption: Option<NativeSessionResumption>,
    /// Resolver preset name.
    pub dns: Option<String>,
    /// A DNS server to query directly: an IP address with an optional port.
    pub dns_server: Option<String>,
    /// A resolver written in JavaScript: its `resolve(host, port)`.
    #[napi(ts_type = "(host: string, port: number) => Promise<string[]>")]
    pub dns_resolve: Option<ResolveFn>,
    /// A resolver written in JavaScript: its `lookupHttps(host)`.
    #[napi(ts_type = "(host: string) => Promise<NativeHttpsRecord | null>")]
    pub dns_lookup_https: Option<LookupHttpsFn>,
    /// Positive-result cache TTL for the system resolver.
    pub dns_cache_ttl: Option<f64>,
    /// Entry cap of the system resolver's cache.
    pub dns_cache_max_entries: Option<f64>,
    /// Address family to connect over: 0 (any), 4 or 6.
    pub family: Option<u32>,
    /// Fixed addresses to dial per origin.
    pub connect_to: Option<Vec<NativeDialOverride>>,
    /// Protocol policy: a preset, adjusted axis by axis.
    pub protocol_policy: Option<NativeProtocolPolicy>,
    /// Never attempt HTTP/3.
    pub disable_http3: Option<bool>,
    /// Fingerprint randomization policy.
    pub randomize: Option<NativeRandomize>,
    /// The outer hop of `masque://` proxies.
    pub masque: Option<NativeMasqueOptions>,
}

/// Fingerprint profiles that override the preset's, each a profile object.
#[napi(object, object_to_js = false)]
pub struct NativeFingerprints<'env> {
    /// TLS ClientHello over TCP.
    pub tls_profile: Option<ClassInstance<'env, NativeTlsProfile>>,
    /// HTTP/2 fingerprint.
    pub h2_profile: Option<ClassInstance<'env, NativeH2Profile>>,
    /// TCP fingerprint.
    pub tcp_fingerprint: Option<ClassInstance<'env, NativeTcpFingerprint>>,
    /// TLS ClientHello inside QUIC.
    pub quic_fingerprint: Option<ClassInstance<'env, NativeTlsProfile>>,
    /// QUIC / HTTP/3 fingerprint.
    pub quic_profile: Option<ClassInstance<'env, NativeQuicProfile>>,
}

/// The upstream profiles of a `NativeFingerprints`, copied out of their JavaScript objects.
#[derive(Default)]
struct Fingerprints {
    tls: Option<TlsProfile>,
    h2: Option<H2Profile>,
    tcp: Option<TcpFingerprint>,
    quic_tls: Option<TlsProfile>,
    quic: Option<QuicProfile>,
}

impl From<NativeFingerprints<'_>> for Fingerprints {
    /// Copies each profile.
    fn from(objects: NativeFingerprints<'_>) -> Self {
        Self {
            tls: objects.tls_profile.map(|profile| profile.inner.clone()),
            h2: objects.h2_profile.map(|profile| profile.inner.clone()),
            tcp: objects.tcp_fingerprint.map(|profile| profile.inner.clone()),
            quic_tls: objects
                .quic_fingerprint
                .map(|profile| profile.inner.clone()),
            quic: objects
                .quic_profile
                .and_then(|profile| quic_inner(&profile)),
        }
    }
}

/// What the client fingerprints as.
#[napi(object, object_from_js = false)]
pub struct NativeFingerprintInfo {
    /// Name of the TLS profile.
    pub tls_profile: String,
    /// Number of HTTP/2 SETTINGS entries.
    pub h2_settings_count: u32,
    /// HTTP/2 connection WINDOW_UPDATE increment.
    pub h2_window_update: u32,
    /// The TCP fingerprint as JA4T, when the client has one.
    pub tcp_ja4t: Option<String>,
}

/// How outbound HTTP/2 DATA payloads are capped.
#[napi(object, object_to_js = false)]
pub struct NativeH2DataFramePolicy {
    /// `browser_default`, `peer_max_frame_size`, `fixed_payload` or `socket_write_aligned`.
    pub mode: String,
    /// Byte count of the two sized modes.
    pub size: Option<f64>,
}

/// The native client behind the public `Client`.
#[napi]
pub struct NativeClient {
    pub(crate) inner: Client,
}

#[napi]
impl NativeClient {
    /// Builds a client; invalid options throw synchronously.
    #[napi(constructor, catch_unwind)]
    pub fn new(
        options: Option<NativeClientOptions>,
        fingerprints: Option<NativeFingerprints<'_>>,
    ) -> napi::Result<Self> {
        let fingerprints = fingerprints.map(Fingerprints::from).unwrap_or_default();
        let builder = match options {
            Some(options) => configure(Client::builder(), options, fingerprints)?,
            None => apply_fingerprints(Client::builder(), fingerprints),
        };
        Ok(Self {
            inner: builder.build(),
        })
    }

    /// What the client fingerprints as.
    #[napi(getter)]
    pub fn fingerprint_info(&self) -> NativeFingerprintInfo {
        let h2 = self.inner.h2_profile();
        NativeFingerprintInfo {
            tls_profile: self.inner.tls_profile().name.clone(),
            h2_settings_count: u32::try_from(h2.settings.len()).unwrap_or(u32::MAX),
            h2_window_update: h2.window_update,
            tcp_ja4t: self
                .inner
                .tcp_fingerprint()
                .and_then(TcpFingerprint::to_ja4t),
        }
    }

    /// The TLS profile the client uses.
    #[napi]
    pub fn tls_profile(&self) -> NativeTlsProfile {
        NativeTlsProfile {
            inner: self.inner.tls_profile().clone(),
        }
    }

    /// Creates a session that shares this client's configuration.
    #[napi(catch_unwind)]
    pub fn session(
        &self,
        options: Option<NativeSessionOptions>,
        hsts: Option<&NativeHsts>,
        proxy: Option<&NativeProxyConfig>,
    ) -> napi::Result<NativeSession> {
        NativeSession::new(&self.inner, options, hsts, proxy)
    }

    /// Ready HTTP/2 requests coalesced into one write turn.
    #[napi(getter)]
    pub fn h2_dispatch_batch_size(&self) -> u32 {
        u32::try_from(self.inner.h2_dispatch_batch_size()).unwrap_or(u32::MAX)
    }

    /// Whether a TLS connection closed without `close_notify` is an error.
    #[napi(getter)]
    pub fn require_close_notify(&self) -> bool {
        self.inner.require_close_notify()
    }

    /// Whether TLS session tickets are cached and offered.
    #[napi(getter)]
    pub fn tls_session_resumption_policy(&self) -> NativeResumptionPolicy {
        describe_resumption_policy(self.inner.tls_session_resumption_policy())
    }
}

/// Applies every option to the builder, in the same order as lkrequest-py.
fn configure(
    mut builder: ClientBuilder,
    mut options: NativeClientOptions,
    fingerprints: Fingerprints,
) -> napi::Result<ClientBuilder> {
    if let Some(name) = &options.preset {
        let (bundle, tcp) =
            preset::resolve(name).ok_or_else(|| invalid_arg(format!("unknown preset {name:?}")))?;
        builder = builder.preset(bundle).tcp_fingerprint(tcp);
    }
    // Explicit profiles override the preset's, and must precede `sessionResumption`, which
    // edits the TLS profile set so far.
    builder = apply_fingerprints(builder, fingerprints);
    if let Some(headers) = &options.default_headers {
        for (name, value) in pairs(headers, "defaultHeaders")? {
            builder = builder.default_header(name, value);
        }
    }
    if let Some(order) = &options.header_order {
        builder = builder.header_order(str_refs(order));
    }
    if let Some(order) = &options.cookie_order {
        builder = builder.cookie_order(str_refs(order));
    }
    if let Some(order) = &options.h3_header_order {
        builder = builder.h3_header_order(str_refs(order));
    }
    builder = configure_timeouts(builder, &options)?;
    builder = configure_limits(builder, &options)?;
    builder = configure_protocols(builder, &options)?;
    let resolver = match (options.dns_resolve.take(), options.dns_lookup_https.take()) {
        (Some(resolve), lookup_https) => Some((resolve, lookup_https)),
        (None, None) => None,
        (None, Some(_)) => {
            return Err(invalid_arg("dns.lookupHttps needs dns.resolve"));
        }
    };
    builder = dns::configure(
        builder,
        DnsOptions {
            dns: options.dns.as_deref(),
            server: options.dns_server.as_deref(),
            resolver,
            cache_ttl: options.dns_cache_ttl,
            cache_max_entries: options.dns_cache_max_entries,
            family: options.family,
            connect_to: options.connect_to.as_deref(),
        },
    )?;
    builder = configure_tls(builder, options)?;
    Ok(builder)
}

/// Gathers the timeouts into one `TimeoutConfig`, seeded from upstream's defaults.
fn configure_timeouts(
    builder: ClientBuilder,
    options: &NativeClientOptions,
) -> napi::Result<ClientBuilder> {
    let timeouts = [
        options.dns_timeout,
        options.tcp_connect_timeout,
        options.tls_handshake_timeout,
        options.ttfb_timeout,
        options.total_timeout,
        options.quic_connect_timeout,
    ];
    if timeouts.iter().all(Option::is_none) {
        return Ok(builder);
    }
    let mut config = TimeoutConfig::default();
    if let Some(ms) = options.dns_timeout {
        config.dns_timeout = Some(duration_from_ms(ms, "timeouts.dns")?);
    }
    if let Some(ms) = options.tcp_connect_timeout {
        config.tcp_connect_timeout = Some(duration_from_ms(ms, "timeouts.tcpConnect")?);
    }
    if let Some(ms) = options.tls_handshake_timeout {
        config.tls_handshake_timeout = Some(duration_from_ms(ms, "timeouts.tlsHandshake")?);
    }
    if let Some(ms) = options.ttfb_timeout {
        config.ttfb_timeout = Some(duration_from_ms(ms, "timeouts.ttfb")?);
    }
    if let Some(ms) = options.total_timeout {
        config.total_timeout = Some(duration_from_ms(ms, "timeouts.total")?);
    }
    if let Some(ms) = options.quic_connect_timeout {
        config.quic_connect_timeout = Some(duration_from_ms(ms, "timeouts.quicConnect")?);
    }
    Ok(builder.timeout_config(config))
}

/// Gathers the resource limits into one `ResourceLimits`, plus the HTTP/2 queue settings and
/// fallbacks, which upstream configures separately.
fn configure_limits(
    mut builder: ClientBuilder,
    options: &NativeClientOptions,
) -> napi::Result<ClientBuilder> {
    let limits = [
        options.max_response_body_size,
        options.max_connections_per_session,
        options.max_header_count,
        options.max_header_size,
        options.max_headers_total_size,
        options.min_transfer_rate,
    ];
    if limits.iter().any(Option::is_some) {
        let mut config = ResourceLimits::default();
        if let Some(size) = options.max_response_body_size {
            config.max_response_body_size = usize_from(size, "limits.maxResponseBodySize")?;
        }
        if let Some(n) = options.max_connections_per_session {
            config.max_connections_per_session = usize_from(n, "limits.maxConnectionsPerSession")?;
        }
        if let Some(n) = options.max_header_count {
            config.max_header_count = usize_from(n, "limits.maxHeaderCount")?;
        }
        if let Some(n) = options.max_header_size {
            config.max_header_size = usize_from(n, "limits.maxHeaderSize")?;
        }
        if let Some(n) = options.max_headers_total_size {
            config.max_headers_total_size = usize_from(n, "limits.maxHeadersTotalSize")?;
        }
        if let Some(rate) = options.min_transfer_rate {
            config.min_transfer_rate = Some(usize_from(rate, "limits.minTransferRate")?);
            if let Some(ms) = options.min_transfer_rate_window {
                config.transfer_rate_window = duration_from_ms(ms, "limits.minTransferRateWindow")?;
            }
        }
        builder = builder.resource_limits(config);
    }
    // Upstream asserts both are non-zero, which would surface as a panic.
    if let Some(n) = options.max_pending_h2_requests {
        builder = builder.max_pending_h2_requests(positive(n, "limits.maxPendingH2Requests")?);
    }
    if let Some(n) = options.h2_dispatch_batch_size {
        builder = builder.h2_dispatch_batch_size(positive(n, "h2.dispatchBatchSize")?);
    }
    if let Some(enabled) = options.h2_fallback_h1 {
        builder = builder.h2_fallback_h1(enabled);
    }
    if let Some(enabled) = options.proxy_fallback_direct {
        builder = builder.proxy_fallback_direct(enabled);
    }
    if let Some(enabled) = options.retry_on_connection_close {
        builder = builder.retry_on_connection_close(enabled);
    }
    Ok(builder)
}

/// Applies trust anchors, verification and the other TLS options.
fn configure_tls(
    mut builder: ClientBuilder,
    options: NativeClientOptions,
) -> napi::Result<ClientBuilder> {
    for pem in options.ca_pem.iter().flatten() {
        builder = builder.add_ca_certs_pem(&pem.0);
    }
    for der in options.ca_der.iter().flatten() {
        builder = builder.add_ca_cert_der(&der.0);
    }
    if let Some(verify) = options.reject_unauthorized {
        builder = builder.verify(verify);
    }
    if options.use_native_certs == Some(true) {
        builder = builder.use_native_certs();
    }
    if let Some(ech) = options.ech {
        builder = builder.ech_config(ech.0.to_vec());
    }
    match (&options.keylog, options.keylog_fn) {
        (Some(_), Some(_)) => {
            return Err(invalid_arg(
                "tls.keylog is a file path or a function, not both",
            ));
        }
        (Some(path), None) => {
            let callback = lkrequest::keylog_to_file(path)
                .map_err(|err| invalid_arg(format!("cannot open keylog file {path:?}: {err}")))?;
            builder = builder.keylog(callback);
        }
        (None, Some(sink)) => builder = builder.keylog(keylog::callback(sink)),
        (None, None) => {}
    }
    if let Some(require) = options.require_close_notify {
        builder = builder.require_close_notify(require);
    }
    if let Some(policy) = &options.tls_session_resumption_policy {
        builder =
            builder.tls_session_resumption_policy(network_partition::resumption_policy(policy)?);
    }
    if let Some(name) = &options.tls_session_cache_partition_policy {
        builder =
            builder.tls_session_cache_partition_policy(network_partition::partition_policy(name)?);
    }
    Ok(builder)
}

/// Applies the protocol policy, HTTP/3 switch, HTTP/2 DATA framing and the resumption modes
/// the TLS profile advertises.
fn configure_protocols(
    mut builder: ClientBuilder,
    options: &NativeClientOptions,
) -> napi::Result<ClientBuilder> {
    if let Some(spec) = &options.protocol_policy {
        let policy = protocol::protocol_policy(spec, &preset_protocol_policy(options))?;
        builder = builder.protocol_policy(policy);
    }
    if options.disable_http3 == Some(true) {
        builder = builder.disable_http3();
    }
    if let Some(policy) = &options.h2_data_frame_policy {
        builder = builder.h2_data_frame_policy(h2_data_frame_policy(policy)?);
    }
    // Upstream writes this into the TLS profile set so far, so it must follow `preset`.
    if let Some(resumption) = &options.session_resumption {
        builder = builder.session_resumption(network_partition::session_resumption(resumption)?);
    }
    if let Some(policy) = &options.randomize {
        builder = builder.randomize(randomize::randomize(policy)?);
    }
    if let Some(outer) = &options.masque {
        builder = masque::apply_to_client(builder, outer)?;
    }
    Ok(builder)
}

/// The protocol policy the client would have without an explicit `protocolPolicy`: its browser
/// preset's own, else upstream's default. It is the starting point of a policy that names no
/// preset.
fn preset_protocol_policy(options: &NativeClientOptions) -> ProtocolPolicy {
    options
        .preset
        .as_deref()
        .and_then(preset::resolve)
        .and_then(|(bundle, _)| bundle.default_protocol_policy)
        .unwrap_or_default()
}

/// Installs the explicit fingerprint profiles.
fn apply_fingerprints(mut builder: ClientBuilder, fingerprints: Fingerprints) -> ClientBuilder {
    if let Some(profile) = fingerprints.tls {
        builder = builder.fingerprint(profile);
    }
    if let Some(profile) = fingerprints.h2 {
        builder = builder.h2_profile(profile);
    }
    if let Some(fingerprint) = fingerprints.tcp {
        builder = builder.tcp_fingerprint(fingerprint);
    }
    if let Some(profile) = fingerprints.quic_tls {
        builder = builder.quic_fingerprint(profile);
    }
    if let Some(profile) = fingerprints.quic {
        builder = builder.quic_profile(profile);
    }
    builder
}

/// The upstream QUIC profile of a profile object.
#[cfg(feature = "quic-h3")]
fn quic_inner(profile: &NativeQuicProfile) -> Option<QuicProfile> {
    Some(profile.inner.clone())
}

/// No QUIC profile object can exist without the feature.
#[cfg(not(feature = "quic-h3"))]
fn quic_inner(_profile: &NativeQuicProfile) -> Option<QuicProfile> {
    None
}

/// The upstream DATA frame policy `policy` describes, rejecting sizes upstream asserts on.
fn h2_data_frame_policy(policy: &NativeH2DataFramePolicy) -> napi::Result<H2DataFramePolicy> {
    match (policy.mode.as_str(), policy.size) {
        ("browser_default", None) => Ok(H2DataFramePolicy::BrowserDefault),
        ("peer_max_frame_size", None) => Ok(H2DataFramePolicy::PeerMaxFrameSize),
        ("fixed_payload", Some(size)) => Ok(H2DataFramePolicy::FixedPayload(positive(
            size,
            "h2.dataFramePolicy.fixedPayload",
        )?)),
        ("socket_write_aligned", Some(size)) => {
            let name = "h2.dataFramePolicy.socketWriteAligned";
            match usize_from(size, name)? {
                max_write_size if max_write_size > 9 => {
                    Ok(H2DataFramePolicy::SocketWriteAligned { max_write_size })
                }
                _ => Err(invalid_arg(format!(
                    "{name} must exceed the 9-byte HTTP/2 frame header"
                ))),
            }
        }
        _ => Err(invalid_arg(
            "h2.dataFramePolicy must be \"browser_default\", \"peer_max_frame_size\", \
             { fixedPayload } or { socketWriteAligned }",
        )),
    }
}

/// A count that upstream requires to be at least one.
fn positive(value: f64, name: &str) -> napi::Result<usize> {
    match usize_from(value, name)? {
        0 => Err(invalid_arg(format!("{name} must be greater than 0"))),
        n => Ok(n),
    }
}
