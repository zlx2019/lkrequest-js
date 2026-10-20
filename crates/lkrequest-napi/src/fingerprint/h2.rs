//! HTTP/2 profiles: SETTINGS, WINDOW_UPDATE, pseudo-header order and priorities.

use lkrequest::lkh2::profile::{
    self as h2, H2Profile, H2Setting, H2SettingId, HeadersPriority, PriorityConfig,
    ProfilePriorityFrame, PseudoHeaderId, StreamDepPolicy,
};
use lkrequest::lkh2::synthesis;
use napi_derive::napi;

use super::{Presets, lookup, names};
use crate::bridge::buffer::JsBytes;
use crate::error::invalid_arg;

/// Largest client stream id; upstream's own constant is crate-private.
const MAX_CLIENT_STREAM_ID: u32 = 0x7fff_ffff;

/// Every HTTP/2 preset, by the browser name the TLS and client presets use.
const PRESETS: &Presets<H2Profile> = &[
    ("chrome_131", h2::chrome_131_h2),
    ("chrome_144", h2::chrome_144_h2),
    ("chrome_145", h2::chrome_145_h2),
    ("chrome_146", h2::chrome_146_h2),
    ("chrome_147", h2::chrome_147_h2),
    ("chrome_148", h2::chrome_148_h2),
    ("chrome_149", h2::chrome_149_h2),
    ("chrome_150", h2::chrome_150_h2),
    ("chrome_151", h2::chrome_151_h2),
    ("chrome_152", h2::chrome_152_h2),
    ("chrome_153", h2::chrome_153_h2),
    ("chrome_154", h2::chrome_154_h2),
    ("chrome_155", h2::chrome_155_h2),
    ("firefox_133", h2::firefox_133_h2),
    ("firefox_147", h2::firefox_147_h2),
    ("firefox_156", h2::firefox_156_h2),
    ("safari_18", h2::safari_18_h2),
    ("safari_26", h2::safari_26_h2),
];

/// One SETTINGS entry: a known setting by name, or any setting by its numeric id.
#[napi(object, object_to_js = false)]
pub struct NativeH2Setting {
    /// Setting name such as `header_table_size`.
    pub name: Option<String>,
    /// Numeric setting id, for settings without a name.
    pub id: Option<u32>,
    /// Setting value.
    pub value: u32,
}

/// Priority of the HEADERS frame.
#[napi(object, object_to_js = false)]
pub struct NativeHeadersPriority {
    /// Stream the request depends on.
    pub stream_dependency: u32,
    /// Weight, 1 to 256 on the wire (stored minus one, 0 to 255).
    pub weight: u32,
    /// Exclusive dependency.
    pub exclusive: bool,
}

/// A PRIORITY frame sent after the preface.
#[napi(object, object_to_js = false)]
pub struct NativePriorityFrame {
    /// Stream the frame is for.
    pub stream_id: u32,
    /// Stream it depends on.
    pub dependency: u32,
    /// Weight (stored minus one, 0 to 255).
    pub weight: u32,
    /// Exclusive dependency.
    pub exclusive: bool,
}

/// How request priorities map onto HTTP/2.
#[napi(object)]
pub struct NativePriorityConfig {
    /// `chrome`, `firefox`, `safari18`, `safari26` or `default`; the other fields are ignored
    /// when set. Absent when read back.
    pub preset: Option<String>,
    /// Weight per urgency 0–7 (exactly eight values).
    pub urgency_weights: Option<Vec<u32>>,
    /// Exclusive stream dependencies.
    pub exclusive: Option<bool>,
    /// `flat`, `chain` or `priority_chain`.
    pub stream_dep_policy: Option<String>,
    /// Send a `priority` header derived from the request priority.
    pub auto_priority_header: Option<bool>,
    /// Urgency of requests without a priority (0–7, default 3).
    pub default_urgency: Option<u32>,
    /// Whether requests without a priority are incremental.
    pub default_incremental: Option<bool>,
}

/// A hand-built HTTP/2 profile.
#[napi(object, object_to_js = false)]
pub struct NativeH2ProfileOptions {
    /// SETTINGS entries, in order.
    pub settings: Vec<NativeH2Setting>,
    /// Connection WINDOW_UPDATE increment.
    pub window_update: u32,
    /// Pseudo-header order: `method`, `authority`, `scheme`, `path`.
    pub pseudo_header_order: Vec<String>,
    /// Priority of the HEADERS frame.
    pub headers_priority: Option<NativeHeadersPriority>,
    /// PRIORITY frames sent after the preface.
    pub priority_frames: Option<Vec<NativePriorityFrame>>,
    /// Request priority mapping.
    pub priority_config: Option<NativePriorityConfig>,
    /// Stream id of the first request on a connection: odd, from 1 to 2^31-1 (default 1).
    pub initial_stream_id: Option<u32>,
}

/// An HTTP/2 fingerprint profile.
#[napi]
pub struct NativeH2Profile {
    pub(crate) inner: H2Profile,
}

#[napi]
impl NativeH2Profile {
    /// A preset by name (`chrome_155`, `firefox_156`, ...).
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

    /// A hand-built profile.
    #[napi(factory)]
    pub fn create(options: NativeH2ProfileOptions) -> napi::Result<Self> {
        Ok(Self {
            inner: build(options)?,
        })
    }

    /// A profile from its JSON form.
    #[napi(factory)]
    pub fn from_json(json: String) -> napi::Result<Self> {
        let inner = serde_json::from_str(&json)
            .map_err(|err| invalid_arg(format!("invalid HTTP/2 profile JSON: {err}")))?;
        Ok(Self { inner })
    }

    /// A profile rebuilt from captured HTTP/2 frames, starting with the connection preface.
    #[napi(factory, catch_unwind)]
    pub fn from_h2_frames(#[napi(ts_arg_type = "Uint8Array")] data: JsBytes) -> napi::Result<Self> {
        let fingerprint = lkprofile::h2_fingerprint_from_frames(&data.0)
            .map_err(|err| invalid_arg(format!("cannot parse the HTTP/2 frames: {err}")))?;
        // lkprofile has its own profile type, serde-compatible with upstream's.
        let inner = serde_json::to_value(&fingerprint.profile)
            .and_then(serde_json::from_value)
            .map_err(|err| invalid_arg(format!("cannot convert the HTTP/2 profile: {err}")))?;
        Ok(Self { inner })
    }

    /// The profile as JSON, in upstream's format.
    #[napi]
    pub fn to_json(&self) -> napi::Result<String> {
        serde_json::to_string(&self.inner)
            .map_err(|err| napi::Error::from_reason(format!("cannot serialize the profile: {err}")))
    }

    /// Throws when the profile breaks the structural rules of HTTP/2: the pseudo-headers, the
    /// SETTINGS values, or a WINDOW_UPDATE that would overflow the connection window.
    #[napi]
    pub fn validate(&self) -> napi::Result<()> {
        synthesis::validate(&self.inner).map_err(|err| invalid_arg(err.to_string()))
    }

    /// The request priority mapping.
    #[napi(getter)]
    pub fn priority_config(&self) -> NativePriorityConfig {
        let config = &self.inner.priority_config;
        NativePriorityConfig {
            preset: None,
            urgency_weights: config
                .urgency_weights
                .map(|weights| weights.iter().map(|&weight| u32::from(weight)).collect()),
            exclusive: Some(config.exclusive),
            stream_dep_policy: Some(
                match config.stream_dep_policy {
                    StreamDepPolicy::Flat => "flat",
                    StreamDepPolicy::Chain => "chain",
                    StreamDepPolicy::PriorityChain => "priority_chain",
                }
                .to_owned(),
            ),
            auto_priority_header: Some(config.auto_priority_header),
            default_urgency: Some(u32::from(config.default_urgency)),
            default_incremental: Some(config.default_incremental),
        }
    }

    /// Stream id of the first request on a connection.
    #[napi(getter)]
    pub fn initial_stream_id(&self) -> u32 {
        self.inner.initial_stream_id
    }
}

/// An HTTP/2 preset by name.
pub(crate) fn preset(name: &str) -> napi::Result<H2Profile> {
    lookup(PRESETS, "HTTP/2 profile", name)
}

/// Builds a profile the way lkrequest-py's `H2Profile(...)` constructor does.
fn build(options: NativeH2ProfileOptions) -> napi::Result<H2Profile> {
    let settings = options
        .settings
        .iter()
        .map(setting)
        .collect::<napi::Result<Vec<_>>>()?;
    let pseudo_header_order = options
        .pseudo_header_order
        .iter()
        .map(|name| pseudo_header(name))
        .collect::<napi::Result<Vec<_>>>()?;
    let weight = |value: u32| {
        u8::try_from(value).map_err(|_| invalid_arg("priority weights must be between 0 and 255"))
    };
    let headers_priority = options
        .headers_priority
        .map(|priority| {
            Ok::<_, napi::Error>(HeadersPriority {
                stream_dependency: priority.stream_dependency,
                weight: weight(priority.weight)?,
                exclusive: priority.exclusive,
            })
        })
        .transpose()?;
    let priority_frames = options
        .priority_frames
        .unwrap_or_default()
        .into_iter()
        .map(|frame| {
            Ok(ProfilePriorityFrame {
                stream_id: frame.stream_id,
                dependency: frame.dependency,
                weight: weight(frame.weight)?,
                exclusive: frame.exclusive,
            })
        })
        .collect::<napi::Result<Vec<_>>>()?;
    let initial_stream_id = options.initial_stream_id.unwrap_or(1);
    // Upstream checks the id only when a connection opens; a hand-built profile fails here.
    if initial_stream_id.is_multiple_of(2) || initial_stream_id > MAX_CLIENT_STREAM_ID {
        return Err(invalid_arg(
            "initialStreamId must be an odd number from 1 to 2^31-1",
        ));
    }
    Ok(H2Profile {
        initial_stream_id,
        settings,
        window_update: options.window_update,
        pseudo_header_order,
        headers_priority,
        priority_frames,
        priority_config: options
            .priority_config
            .as_ref()
            .map(priority_config)
            .transpose()?
            .unwrap_or_default(),
        behavior: None,
    })
}

/// One SETTINGS entry.
fn setting(setting: &NativeH2Setting) -> napi::Result<H2Setting> {
    let id = match (&setting.name, setting.id) {
        (Some(name), None) => setting_id(name)?,
        (None, Some(id)) => H2SettingId::Unknown(
            u16::try_from(id)
                .map_err(|_| invalid_arg("setting ids must be between 0 and 65535"))?,
        ),
        _ => return Err(invalid_arg("a setting needs either a name or a numeric id")),
    };
    Ok(H2Setting {
        id,
        value: setting.value,
    })
}

/// A setting id by name.
fn setting_id(name: &str) -> napi::Result<H2SettingId> {
    match name {
        "header_table_size" => Ok(H2SettingId::HeaderTableSize),
        "enable_push" => Ok(H2SettingId::EnablePush),
        "max_concurrent_streams" => Ok(H2SettingId::MaxConcurrentStreams),
        "initial_window_size" => Ok(H2SettingId::InitialWindowSize),
        "max_frame_size" => Ok(H2SettingId::MaxFrameSize),
        "max_header_list_size" => Ok(H2SettingId::MaxHeaderListSize),
        "enable_connect_protocol" => Ok(H2SettingId::EnableConnectProtocol),
        "no_rfc7540_priorities" => Ok(H2SettingId::NoRfc7540Priorities),
        other => Err(invalid_arg(format!(
            "unknown HTTP/2 setting {other:?}; expected header_table_size, enable_push, \
             max_concurrent_streams, initial_window_size, max_frame_size, max_header_list_size, \
             enable_connect_protocol, no_rfc7540_priorities, or a numeric id"
        ))),
    }
}

/// A pseudo-header by name.
fn pseudo_header(name: &str) -> napi::Result<PseudoHeaderId> {
    match name {
        "method" => Ok(PseudoHeaderId::Method),
        "authority" => Ok(PseudoHeaderId::Authority),
        "scheme" => Ok(PseudoHeaderId::Scheme),
        "path" => Ok(PseudoHeaderId::Path),
        other => Err(invalid_arg(format!(
            "unknown pseudo-header {other:?}; expected method, authority, scheme or path"
        ))),
    }
}

/// A priority mapping: a preset, or lkrequest-py's defaults overridden field by field.
fn priority_config(options: &NativePriorityConfig) -> napi::Result<PriorityConfig> {
    if let Some(name) = &options.preset {
        return match name.as_str() {
            "default" => Ok(PriorityConfig::default()),
            "chrome" => Ok(PriorityConfig::chrome()),
            "firefox" => Ok(PriorityConfig::firefox()),
            "safari18" => Ok(PriorityConfig::safari18()),
            "safari26" => Ok(PriorityConfig::safari26()),
            other => Err(invalid_arg(format!(
                "unknown priority config {other:?}; expected default, chrome, firefox, safari18 \
                 or safari26"
            ))),
        };
    }
    let urgency_weights = options
        .urgency_weights
        .as_ref()
        .map(|weights| {
            let weights = super::u8_list(weights, "urgencyWeights")?;
            <[u8; 8]>::try_from(weights).map_err(|weights| {
                invalid_arg(format!(
                    "urgencyWeights must have exactly 8 values, not {}",
                    weights.len()
                ))
            })
        })
        .transpose()?;
    let default_urgency = options.default_urgency.unwrap_or(3);
    if default_urgency > 7 {
        return Err(invalid_arg("defaultUrgency must be between 0 and 7"));
    }
    Ok(PriorityConfig {
        urgency_weights,
        exclusive: options.exclusive.unwrap_or(false),
        stream_dep_policy: match options.stream_dep_policy.as_deref().unwrap_or("flat") {
            "flat" => StreamDepPolicy::Flat,
            "chain" => StreamDepPolicy::Chain,
            "priority_chain" => StreamDepPolicy::PriorityChain,
            other => {
                return Err(invalid_arg(format!(
                    "unknown streamDepPolicy {other:?}; expected flat, chain or priority_chain"
                )));
            }
        },
        auto_priority_header: options.auto_priority_header.unwrap_or(false),
        default_urgency: default_urgency as u8,
        default_incremental: options.default_incremental.unwrap_or(false),
    })
}
