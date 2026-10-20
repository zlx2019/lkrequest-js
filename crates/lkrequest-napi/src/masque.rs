//! MASQUE (RFC 9298 CONNECT-UDP) proxy options: the outer HTTP/3 hop to a `masque://` proxy.
//!
//! Ported from lkrequest-py's `src/masque.rs`. The options exist in every build, so the
//! facade's types stay the same; without the `masque` feature a value is refused with an
//! actionable message rather than ignored.

use lkrequest::HealthCheckConfig;
use lkrequest::client::ClientBuilder;
use napi_derive::napi;

use crate::bridge::buffer::JsBytes;
use crate::error::invalid_arg;

/// The outer hop to a MASQUE proxy. Trust is configured here, separately from the client's
/// TLS options, which only govern the tunneled connection to the origin.
#[napi(object, object_to_js = false)]
pub struct NativeMasqueOptions {
    /// Server name for the proxy's certificate, instead of the proxy's host.
    pub server_name: Option<String>,
    /// Extra trust anchors as PEM documents.
    #[napi(ts_type = "Uint8Array[]")]
    pub ca_pem: Option<Vec<JsBytes>>,
    /// Trust the operating system's certificate store too (default `true`).
    pub use_native_certs: Option<bool>,
    /// Verify the proxy's certificate (default `true`).
    pub reject_unauthorized: Option<bool>,
    /// How long an idle tunnel is kept, in milliseconds; `Infinity` keeps it (default 120000).
    pub tunnel_idle_timeout: Option<f64>,
    /// Idle tunnels kept at most; 0 removes the cap (default 256).
    pub max_idle_tunnels: Option<f64>,
}

/// Configures the outer hop of `masque://` routes.
#[cfg(feature = "masque")]
pub(crate) fn apply_to_client(
    builder: ClientBuilder,
    options: &NativeMasqueOptions,
) -> napi::Result<ClientBuilder> {
    Ok(builder.masque(outer_config(options)?))
}

/// Refuses MASQUE options in a build without the feature.
#[cfg(not(feature = "masque"))]
pub(crate) fn apply_to_client(
    _builder: ClientBuilder,
    _options: &NativeMasqueOptions,
) -> napi::Result<ClientBuilder> {
    Err(feature_required("masque"))
}

/// Configures the CONNECT-UDP probe of a health check. A plain check only proves a TCP
/// connect, which says nothing about a MASQUE proxy, so upstream skips those unless the probe
/// is on, and the probe needs to know how to reach the proxy.
#[cfg(feature = "masque")]
pub(crate) fn apply_to_health_check(
    config: &mut HealthCheckConfig,
    tunnel_probe: Option<bool>,
    masque: Option<&NativeMasqueOptions>,
) -> napi::Result<()> {
    let tunnel_probe = tunnel_probe.unwrap_or(false);
    if tunnel_probe && masque.is_none() {
        // Upstream would only log and skip the probe; both arrive in one call, so refuse it.
        return Err(invalid_arg(
            "healthCheck.tunnelProbe needs healthCheck.masque: the probe must know which trust \
             anchors the proxy's certificate chains to",
        ));
    }
    config.tunnel_probe = tunnel_probe;
    config.masque_outer_config = masque.map(outer_config).transpose()?;
    Ok(())
}

/// Refuses the probe options in a build without the feature.
#[cfg(not(feature = "masque"))]
pub(crate) fn apply_to_health_check(
    _config: &mut HealthCheckConfig,
    tunnel_probe: Option<bool>,
    masque: Option<&NativeMasqueOptions>,
) -> napi::Result<()> {
    if masque.is_some() {
        return Err(feature_required("healthCheck.masque"));
    }
    if tunnel_probe == Some(true) {
        return Err(feature_required("healthCheck.tunnelProbe"));
    }
    Ok(())
}

/// Upstream's outer-hop settings, from its defaults. The struct is `#[non_exhaustive]`.
#[cfg(feature = "masque")]
fn outer_config(
    options: &NativeMasqueOptions,
) -> napi::Result<lkrequest::proxy::MasqueOuterConfig> {
    use crate::types::{duration_from_ms, usize_from};

    let mut config = lkrequest::proxy::MasqueOuterConfig::default();
    config.server_name = options.server_name.clone();
    if let Some(enabled) = options.use_native_certs {
        config.use_native_certs = enabled;
    }
    if let Some(verify) = options.reject_unauthorized {
        config.verify = verify;
    }
    if let Some(ms) = options.tunnel_idle_timeout {
        config.tunnel_idle_timeout = if ms == f64::INFINITY {
            None
        } else {
            Some(duration_from_ms(ms, "masque.tunnelIdleTimeout")?)
        };
    }
    if let Some(n) = options.max_idle_tunnels {
        config.max_idle_tunnels = usize_from(n, "masque.maxIdleTunnels")?;
    }
    for pem in options.ca_pem.iter().flatten() {
        // A bundle without a usable certificate would only surface later, as a failed
        // handshake with the proxy.
        config
            .add_ca_certs_pem(&pem.0)
            .map_err(|err| invalid_arg(format!("invalid masque.ca: {err}")))?;
    }
    Ok(config)
}

/// The error for a MASQUE option in a build without the feature.
#[cfg(not(feature = "masque"))]
fn feature_required(option: &str) -> napi::Error {
    invalid_arg(format!(
        "{option} requires building lkrequest-js with the 'masque' feature"
    ))
}
