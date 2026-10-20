//! Information about how this build of the addon was compiled.

use napi_derive::napi;

/// Optional capabilities compiled into the native addon.
#[napi(object)]
pub struct Features {
    /// QUIC and HTTP/3 support (`quic-h3`).
    pub quic_h3: bool,
    /// MASQUE (RFC 9298 CONNECT-UDP) proxies (`masque`).
    pub masque: bool,
    /// Built-in DNS-over-HTTPS resolvers (`doh`).
    pub doh: bool,
    /// Wire-level telemetry counters (`telemetry`).
    pub telemetry: bool,
    /// Synthetic fingerprint randomization (`synthetic-fp`).
    pub synthetic_fp: bool,
}

/// Returns the optional features compiled into this build.
#[napi]
pub fn features() -> Features {
    Features {
        quic_h3: cfg!(feature = "quic-h3"),
        masque: cfg!(feature = "masque"),
        doh: cfg!(feature = "doh"),
        telemetry: cfg!(feature = "telemetry"),
        synthetic_fp: cfg!(feature = "synthetic-fp"),
    }
}

/// Returns the version of the native addon, which always equals the npm package version.
#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
