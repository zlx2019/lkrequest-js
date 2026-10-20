//! TCP fingerprints: window size, MSS, window scale, TTL, socket buffers and keep-alive.

use lkrequest::tcp_fingerprint::TcpKeepalive;
use lkrequest::{TcpFingerprint, TcpOption};
use napi_derive::napi;

use super::{Presets, lookup, names};
use crate::error::invalid_arg;
use crate::types::duration_from_ms;

/// Every TCP preset, named after the upstream constructor.
const PRESETS: &Presets<TcpFingerprint> = &[
    ("chrome", TcpFingerprint::chrome),
    ("chrome_win", TcpFingerprint::chrome_win),
    ("chrome_linux", TcpFingerprint::chrome_linux),
    ("chrome_macos", TcpFingerprint::chrome_macos),
    ("firefox", TcpFingerprint::firefox),
    ("firefox_win", TcpFingerprint::firefox_win),
    ("firefox_linux", TcpFingerprint::firefox_linux),
    ("firefox_macos", TcpFingerprint::firefox_macos),
    ("safari", TcpFingerprint::safari),
    ("safari_ios", TcpFingerprint::safari_ios),
    // No customization at all: the operating system's own TCP behavior.
    ("none", TcpFingerprint::none),
];

/// A hand-built TCP fingerprint; what is left out stays at the operating system's default.
#[napi(object, object_to_js = false)]
pub struct NativeTcpFingerprintOptions {
    /// Initial window size.
    pub window_size: Option<u32>,
    /// Maximum segment size.
    pub mss: Option<u32>,
    /// Window scale.
    pub window_scale: Option<u32>,
    /// IP time to live.
    pub ttl: Option<u32>,
    /// Disable Nagle's algorithm.
    pub tcp_nodelay: Option<bool>,
    /// Receive buffer size.
    pub recv_buf_size: Option<u32>,
    /// Send buffer size.
    pub send_buf_size: Option<u32>,
    /// TCP options in SYN order, as option kinds (JA4T part B). The kernel decides what is
    /// sent; this only feeds the JA4T string.
    pub tcp_options: Option<Vec<u32>>,
    /// TCP keep-alive.
    pub keepalive: Option<NativeKeepalive>,
}

/// TCP keep-alive settings; durations in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeKeepalive {
    /// Turn keep-alive on or off.
    pub enabled: bool,
    /// Idle time before the first probe.
    pub idle: Option<f64>,
    /// Time between probes.
    pub interval: Option<f64>,
}

/// A TCP fingerprint.
#[napi]
pub struct NativeTcpFingerprint {
    pub(crate) inner: TcpFingerprint,
}

#[napi]
impl NativeTcpFingerprint {
    /// A preset by name (`chrome`, `chrome_macos`, `firefox_win`, `safari`, ...).
    #[napi(factory)]
    pub fn preset(name: String) -> napi::Result<Self> {
        Ok(Self {
            inner: preset(&name)?,
        })
    }

    /// The names of every preset.
    #[napi]
    pub fn preset_names() -> Vec<&'static str> {
        names(PRESETS)
    }

    /// A hand-built fingerprint.
    #[napi(factory)]
    pub fn create(options: NativeTcpFingerprintOptions) -> napi::Result<Self> {
        let mut inner = TcpFingerprint::none();
        if let Some(value) = options.window_size {
            inner = inner.with_window_size(value);
        }
        if let Some(value) = options.mss {
            inner = inner.with_mss(value);
        }
        if let Some(value) = options.window_scale {
            let scale =
                u8::try_from(value).map_err(|_| invalid_arg("windowScale must be at most 255"))?;
            inner = inner.with_window_scale(scale);
        }
        if let Some(value) = options.ttl {
            inner = inner.with_ttl(value);
        }
        if let Some(value) = options.tcp_nodelay {
            inner = inner.with_tcp_nodelay(value);
        }
        if let Some(value) = options.recv_buf_size {
            inner = inner.with_recv_buf_size(value);
        }
        if let Some(value) = options.send_buf_size {
            inner = inner.with_send_buf_size(value);
        }
        if let Some(kinds) = &options.tcp_options {
            inner = inner.with_tcp_options(tcp_options(kinds)?);
        }
        if let Some(keepalive) = &options.keepalive {
            inner = inner.with_keepalive(keepalive_settings(keepalive)?);
        }
        Ok(Self { inner })
    }

    /// A preset by name, or else a fingerprint parsed from a JA4T string (as lkrequest-py
    /// accepts for `tcp_fingerprint`).
    #[napi(factory)]
    pub fn resolve(spec: String) -> napi::Result<Self> {
        if let Ok(inner) = preset(&spec) {
            return Ok(Self { inner });
        }
        let inner = TcpFingerprint::from_ja4t(&spec).map_err(|err| {
            invalid_arg(format!(
                "{spec:?} is neither a TCP fingerprint preset nor a valid JA4T string: {err}"
            ))
        })?;
        Ok(Self { inner })
    }

    /// A fingerprint from a JA4T string.
    #[napi(factory)]
    pub fn from_ja4t(ja4t: String) -> napi::Result<Self> {
        let inner = TcpFingerprint::from_ja4t(&ja4t)
            .map_err(|err| invalid_arg(format!("invalid JA4T {ja4t:?}: {err}")))?;
        Ok(Self { inner })
    }

    /// The fingerprint as a JA4T string, when it has enough fields for one.
    #[napi]
    pub fn to_ja4t(&self) -> Option<String> {
        self.inner.to_ja4t()
    }
}

/// A TCP preset by name.
pub(crate) fn preset(name: &str) -> napi::Result<TcpFingerprint> {
    lookup(PRESETS, "TCP fingerprint", name)
}

/// The TCP options for a list of option kinds, refusing kinds upstream has no name for.
fn tcp_options(kinds: &[u32]) -> napi::Result<Vec<TcpOption>> {
    kinds
        .iter()
        .map(|&kind| {
            u8::try_from(kind)
                .ok()
                .and_then(TcpOption::from_kind)
                .ok_or_else(|| {
                    invalid_arg(format!(
                        "tcpOptions kind {kind} is not one of 0 (end of list), 1 (no-op), \
                         2 (MSS), 3 (window scale), 4 (SACK permitted), 8 (timestamps)"
                    ))
                })
        })
        .collect()
}

/// Upstream's keep-alive settings for the facade's.
fn keepalive_settings(keepalive: &NativeKeepalive) -> napi::Result<TcpKeepalive> {
    let optional = |value: Option<f64>, name: &str| {
        value
            .map(|ms| duration_from_ms(ms, &format!("keepalive.{name}")))
            .transpose()
    };
    Ok(TcpKeepalive {
        enabled: keepalive.enabled,
        idle: optional(keepalive.idle, "idle")?,
        interval: optional(keepalive.interval, "interval")?,
    })
}
