//! Browser preset registry: the single place that maps preset names to upstream bundles.
//!
//! Upstream `lkrequest` exposes one constructor function per preset but no lookup by name,
//! so this table must be updated whenever an upstream sync adds or removes a preset.

use lkrequest::TcpFingerprint;
use lkrequest::preset::{self as upstream, ClientPreset};
use napi_derive::napi;

/// A browser preset known to this build.
struct PresetEntry {
    /// Canonical preset name, e.g. `chrome_155`.
    name: &'static str,
    /// Browser family the preset emulates.
    browser: &'static str,
    /// Upstream constructor producing the preset bundle.
    build: fn() -> ClientPreset,
    /// TCP fingerprint of the browser family, which `ClientPreset` does not cover.
    tcp: fn() -> TcpFingerprint,
}

/// Builds the preset table from upstream constructor names, grouped by browser family.
///
/// Each preset's name is the name of the upstream function that builds it, so the two can
/// never drift apart.
macro_rules! preset_table {
    ($($browser:literal ($tcp:path): [$($preset:ident),+ $(,)?]),+ $(,)?) => {
        &[$($(
            PresetEntry {
                name: stringify!($preset),
                browser: $browser,
                build: upstream::$preset,
                tcp: $tcp,
            },
        )+)+]
    };
}

/// Every browser preset exposed to JavaScript, in a stable order.
const PRESETS: &[PresetEntry] = preset_table! {
    "chrome" (TcpFingerprint::chrome): [
        chrome_131, chrome_144, chrome_145, chrome_146, chrome_147, chrome_148,
        chrome_149, chrome_150, chrome_151, chrome_152, chrome_153, chrome_154,
        chrome_155,
    ],
    "firefox" (TcpFingerprint::firefox): [firefox_133, firefox_147, firefox_156],
    "safari" (TcpFingerprint::safari): [safari_18, safari_26],
};

/// Summary of a browser preset.
#[napi(object)]
pub struct PresetInfo {
    /// Canonical preset name, e.g. `chrome_155`.
    pub name: String,
    /// Browser family the preset emulates.
    #[napi(ts_type = "\"chrome\" | \"firefox\" | \"safari\"")]
    pub browser: String,
    /// Whether the preset carries a QUIC/HTTP3 fingerprint in this build.
    pub http3: bool,
}

/// Lists every browser preset known to this build, in a stable order.
#[napi]
pub fn list_presets() -> Vec<PresetInfo> {
    PRESETS
        .iter()
        .map(|entry| PresetInfo {
            name: entry.name.to_owned(),
            browser: entry.browser.to_owned(),
            http3: (entry.build)().quic_profile.is_some(),
        })
        .collect()
}

/// The upstream bundle and TCP fingerprint of the preset called `name`, if there is one.
///
/// The TCP fingerprint is layered on by browser family, the same way lkrequest-py builds its
/// preset clients.
pub(crate) fn resolve(name: &str) -> Option<(ClientPreset, TcpFingerprint)> {
    let entry = PRESETS.iter().find(|entry| entry.name == name)?;
    Some(((entry.build)(), (entry.tcp)()))
}
