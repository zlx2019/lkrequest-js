//! TLS session resumption and browser-style partitioning of the session-ticket cache.
//!
//! Two separate upstream settings share the word "resumption": the TLS profile's
//! `SessionResumptionConfig` decides what the ClientHello *advertises* (a fingerprint
//! property), while `TlsSessionResumptionPolicy` decides whether tickets are cached and offered.

use lkrequest::lktls::profile::types::SessionResumptionConfig;
use lkrequest::{
    NetworkPartitionContext, TlsSessionCachePartitionPolicy, TlsSessionResumptionPolicy,
};
use napi_derive::napi;

use crate::error::invalid_arg;
use crate::types::usize_from;

/// The resumption modes a TLS profile advertises: a preset, or the individual switches.
#[napi(object, object_to_js = false)]
pub struct NativeSessionResumption {
    /// `chrome`, `firefox` or `disabled`; the other fields are ignored when set.
    pub preset: Option<String>,
    /// Offer TLS 1.3 PSK resumption (default `true`).
    pub tls13_psk: Option<bool>,
    /// Offer TLS 1.2 session tickets (default `true`).
    pub tls12_session_ticket: Option<bool>,
    /// Store tickets the server issues (default `true`).
    pub store_tickets: Option<bool>,
    /// Tickets kept per host (unbounded when unset).
    pub max_tickets_per_host: Option<f64>,
}

/// Whether TLS session tickets are cached and offered as PSKs.
#[napi(object)]
pub struct NativeResumptionPolicy {
    /// `browser_default`, `disabled` or `enabled`.
    pub mode: String,
    /// Tickets kept per server; set exactly when `mode` is `enabled`.
    pub max_tickets_per_server: Option<f64>,
}

/// A browsing context the session-ticket cache is partitioned by.
#[napi(object, object_to_js = false)]
pub struct NativePartitionContext {
    /// Schemeful top-level site, such as `https://example.com`.
    pub top_level_site: String,
    /// Schemeful site of the frame making the request.
    pub frame_site: String,
    /// Transient partition nonce, for isolated contexts.
    pub nonce: Option<String>,
    /// Opaque browser context, such as Firefox's origin attributes.
    pub browser_context: Option<String>,
}

/// The profile resumption settings `options` describe.
pub(crate) fn session_resumption(
    options: &NativeSessionResumption,
) -> napi::Result<SessionResumptionConfig> {
    if let Some(name) = &options.preset {
        return match name.as_str() {
            "chrome" => Ok(SessionResumptionConfig::chrome()),
            "firefox" => Ok(SessionResumptionConfig::firefox()),
            "disabled" => Ok(SessionResumptionConfig::disabled()),
            _ => Err(invalid_arg(format!(
                "unknown sessionResumption {name:?}; expected one of chrome, firefox, disabled"
            ))),
        };
    }
    let defaults = SessionResumptionConfig::default();
    Ok(SessionResumptionConfig {
        tls13_psk: options.tls13_psk.unwrap_or(defaults.tls13_psk),
        tls12_session_ticket: options
            .tls12_session_ticket
            .unwrap_or(defaults.tls12_session_ticket),
        store_tickets: options.store_tickets.unwrap_or(defaults.store_tickets),
        max_tickets_per_host: options
            .max_tickets_per_host
            .map(|n| usize_from(n, "sessionResumption.maxTicketsPerHost"))
            .transpose()?,
    })
}

/// The ticket-cache policy `policy` describes.
pub(crate) fn resumption_policy(
    policy: &NativeResumptionPolicy,
) -> napi::Result<TlsSessionResumptionPolicy> {
    match (policy.mode.as_str(), policy.max_tickets_per_server) {
        ("browser_default", None) => Ok(TlsSessionResumptionPolicy::BrowserDefault),
        ("disabled", None) => Ok(TlsSessionResumptionPolicy::Disabled),
        ("enabled", Some(n)) => {
            let name = "tls.sessionResumptionPolicy.maxTicketsPerServer";
            // Upstream asserts a positive capacity, which would surface as a panic.
            match usize_from(n, name)? {
                0 => Err(invalid_arg(format!(
                    "{name} must be greater than zero (use \"disabled\" to turn resumption off)"
                ))),
                max_tickets_per_server => Ok(TlsSessionResumptionPolicy::Enabled {
                    max_tickets_per_server,
                }),
            }
        }
        _ => Err(invalid_arg(
            "tls.sessionResumptionPolicy must be \"browser_default\", \"disabled\" or \
             { maxTicketsPerServer }",
        )),
    }
}

/// Describes an upstream ticket-cache policy for the facade.
pub(crate) fn describe_resumption_policy(
    policy: TlsSessionResumptionPolicy,
) -> NativeResumptionPolicy {
    let (mode, max_tickets_per_server) = match policy {
        TlsSessionResumptionPolicy::BrowserDefault => ("browser_default", None),
        TlsSessionResumptionPolicy::Disabled => ("disabled", None),
        TlsSessionResumptionPolicy::Enabled {
            max_tickets_per_server,
        } => ("enabled", Some(max_tickets_per_server as f64)),
    };
    NativeResumptionPolicy {
        mode: mode.to_owned(),
        max_tickets_per_server,
    }
}

/// A session-cache partition policy by name.
pub(crate) fn partition_policy(name: &str) -> napi::Result<TlsSessionCachePartitionPolicy> {
    match name {
        "unpartitioned" => Ok(TlsSessionCachePartitionPolicy::Unpartitioned),
        "top_level_site" => Ok(TlsSessionCachePartitionPolicy::TopLevelSite),
        "top_level_and_frame_site" => Ok(TlsSessionCachePartitionPolicy::TopLevelAndFrameSite),
        "chromium" => Ok(TlsSessionCachePartitionPolicy::Chromium),
        "firefox" => Ok(TlsSessionCachePartitionPolicy::Firefox),
        _ => Err(invalid_arg(format!(
            "unknown tls.sessionCachePartitionPolicy {name:?}; expected one of unpartitioned, \
             top_level_site, top_level_and_frame_site, chromium, firefox"
        ))),
    }
}

/// The upstream partition context `context` describes.
pub(crate) fn partition_context(context: &NativePartitionContext) -> NetworkPartitionContext {
    let mut upstream =
        NetworkPartitionContext::new(context.top_level_site.as_str(), context.frame_site.as_str());
    if let Some(nonce) = &context.nonce {
        upstream = upstream.nonce(nonce.as_str());
    }
    if let Some(browser_context) = &context.browser_context {
        upstream = upstream.browser_context(browser_context.as_str());
    }
    upstream
}
