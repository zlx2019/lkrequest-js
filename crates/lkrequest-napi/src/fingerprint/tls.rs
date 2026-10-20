//! TLS profiles: the ClientHello a client sends.

use lkrequest::lktls::profile::types::{
    DelegatedCredentialConfig, ExtensionSource, GreaseConfig, PaddingStrategy, RandomizationConfig,
};
use lkrequest::lktls::profile::{ExtensionSpec, TlsProfile, TlsVersion, loader, presets};
use napi_derive::napi;

use super::{Presets, lookup, names, u8_list, u16_list};
use crate::bridge::buffer::JsBytes;
use crate::error::invalid_arg;

/// Every TLS preset, named after the upstream function that builds it.
const PRESETS: &Presets<TlsProfile> = &[
    ("chrome_131", presets::chrome_131),
    ("chrome_144", presets::chrome_144),
    ("chrome_145", presets::chrome_145),
    ("chrome_146", presets::chrome_146),
    ("chrome_146_quic", presets::chrome_146_quic),
    ("chrome_147", presets::chrome_147),
    ("chrome_148", presets::chrome_148),
    ("chrome_149", presets::chrome_149),
    ("chrome_150", presets::chrome_150),
    ("chrome_150_quic", presets::chrome_150_quic),
    ("chrome_151", presets::chrome_151),
    ("chrome_151_quic", presets::chrome_151_quic),
    ("chrome_152", presets::chrome_152),
    ("chrome_152_quic", presets::chrome_152_quic),
    ("chrome_153", presets::chrome_153),
    ("chrome_153_quic", presets::chrome_153_quic),
    ("chrome_154", presets::chrome_154),
    ("chrome_154_quic", presets::chrome_154_quic),
    ("chrome_155", presets::chrome_155),
    ("chrome_155_quic", presets::chrome_155_quic),
    ("firefox_133", presets::firefox_133),
    ("firefox_147", presets::firefox_147),
    ("firefox_156", presets::firefox_156),
    ("safari_18", presets::safari_18),
    ("safari_26", presets::safari_26),
];

/// One extension of a hand-built profile.
#[napi(object, object_to_js = false)]
pub struct NativeExtensionSpec {
    /// The extension's code point.
    pub extension_type: u32,
    /// `auto` (default), `grease`, `raw_bytes` or `trust_anchor_ids`.
    pub source: Option<String>,
    /// Hex payload of a `raw_bytes` extension.
    pub raw_data: Option<String>,
    /// Hex identifiers of a `trust_anchor_ids` extension.
    pub trust_anchor_ids: Option<Vec<String>>,
    /// Shuffle the trust anchor identifiers on every ClientHello.
    pub shuffle: Option<bool>,
}

/// Which ClientHello fields carry GREASE values; every switch defaults to off.
#[napi(object, object_to_js = false)]
pub struct NativeGrease {
    /// In the cipher suites.
    pub cipher_suite: Option<bool>,
    /// As an extension.
    pub extensions: Option<bool>,
    /// In the supported groups.
    pub supported_groups: Option<bool>,
    /// In the supported versions.
    pub supported_versions: Option<bool>,
    /// In the signature algorithms.
    pub signature_algorithms: Option<bool>,
    /// In the key shares.
    pub key_share: Option<bool>,
}

/// How the ClientHello is padded.
#[napi(object, object_to_js = false)]
pub struct NativePadding {
    /// `block_align`, `fixed_target` or `none`.
    pub mode: String,
    /// Smallest padded length, for `block_align`.
    pub min_length: Option<u32>,
    /// Block size, for `block_align`.
    pub block_size: Option<u32>,
    /// Exact padded length, for `fixed_target`.
    pub target_length: Option<u32>,
}

/// A hand-built TLS profile, with lkrequest-py's defaults for what is left out.
#[napi(object, object_to_js = false)]
pub struct NativeTlsProfileOptions {
    /// Profile name, for diagnostics.
    pub name: String,
    /// Cipher suite code points, in order.
    pub cipher_suites: Option<Vec<u32>>,
    /// Extensions, in order.
    pub extensions: Option<Vec<NativeExtensionSpec>>,
    /// Supported group code points.
    pub supported_groups: Option<Vec<u32>>,
    /// Signature algorithm code points.
    pub signature_algorithms: Option<Vec<u32>>,
    /// Groups sent a key share for.
    pub key_share_curves: Option<Vec<u32>>,
    /// ALPN protocols (default `["h2", "http/1.1"]`).
    pub alpn_protocols: Option<Vec<String>>,
    /// `tls10` to `tls13` (default `tls12`).
    pub tls_min_version: Option<String>,
    /// `tls10` to `tls13` (default `tls13`).
    pub tls_max_version: Option<String>,
    /// EC point formats (default `[0]`).
    pub ec_point_formats: Option<Vec<u32>>,
    /// Compression methods (default `[0]`).
    pub compression_methods: Option<Vec<u32>>,
    /// GREASE switches.
    pub grease: Option<NativeGrease>,
    /// ClientHello padding.
    pub padding: Option<NativePadding>,
    /// ALPS protocols.
    pub alps_protocols: Option<Vec<String>>,
    /// Certificate compression algorithm code points.
    pub compress_cert_algorithms: Option<Vec<u32>>,
    /// Record size limit extension value.
    pub record_size_limit: Option<u32>,
    /// Signature algorithms of the delegated credentials extension.
    pub delegated_credentials_sig_algs: Option<Vec<u32>>,
    /// Session ID length (default 32).
    pub session_id_length: Option<u32>,
    /// Shuffle the extension order on every connection.
    pub shuffle_extensions: Option<bool>,
}

/// A TLS fingerprint profile.
#[napi]
pub struct NativeTlsProfile {
    pub(crate) inner: TlsProfile,
}

#[napi]
impl NativeTlsProfile {
    /// A preset by name (`chrome_155`, `chrome_155_quic`, `firefox_156`, ...).
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
    pub fn create(options: NativeTlsProfileOptions) -> napi::Result<Self> {
        Ok(Self {
            inner: build(options)?,
        })
    }

    /// A profile from its JSON form.
    #[napi(factory)]
    pub fn from_json(json: String) -> napi::Result<Self> {
        let inner = loader::from_json_str(&json)
            .map_err(|err| invalid_arg(format!("invalid TLS profile JSON: {err}")))?;
        Ok(Self { inner })
    }

    /// A profile rebuilt from captured ClientHello bytes (with or without the record header).
    #[napi(factory, catch_unwind)]
    pub fn from_client_hello(
        #[napi(ts_arg_type = "Uint8Array")] data: JsBytes,
        name: Option<String>,
    ) -> napi::Result<Self> {
        let hello = lkprofile::parse_client_hello(&data.0)
            .map_err(|err| invalid_arg(format!("cannot parse the ClientHello: {err}")))?;
        let name = name.as_deref().unwrap_or("captured");
        Ok(Self {
            inner: lkprofile::build_tls_profile(name, &hello),
        })
    }

    /// The profile as JSON, in upstream's format.
    #[napi]
    pub fn to_json(&self) -> napi::Result<String> {
        serde_json::to_string(&self.inner)
            .map_err(|err| napi::Error::from_reason(format!("cannot serialize the profile: {err}")))
    }

    /// A copy whose extension order is shuffled on every connection, or not.
    #[napi]
    pub fn with_shuffled_extensions(&self, shuffle: bool) -> Self {
        let mut inner = self.inner.clone();
        inner.randomization = Some(RandomizationConfig {
            shuffle_extensions: shuffle,
        });
        Self { inner }
    }

    /// Profile name.
    #[napi(getter)]
    pub fn name(&self) -> String {
        self.inner.name.clone()
    }

    /// Cipher suite code points.
    #[napi(getter)]
    pub fn cipher_suites(&self) -> Vec<u16> {
        self.inner.cipher_suites.clone()
    }

    /// Supported group code points.
    #[napi(getter)]
    pub fn supported_groups(&self) -> Vec<u16> {
        self.inner.supported_groups.clone()
    }

    /// Signature algorithm code points.
    #[napi(getter)]
    pub fn signature_algorithms(&self) -> Vec<u16> {
        self.inner.signature_algorithms.clone()
    }

    /// ALPN protocols.
    #[napi(getter)]
    pub fn alpn_protocols(&self) -> Vec<String> {
        self.inner.alpn_protocols.clone()
    }
}

/// A TLS preset by name.
pub(crate) fn preset(name: &str) -> napi::Result<TlsProfile> {
    lookup(PRESETS, "TLS profile", name)
}

/// Builds a profile the way lkrequest-py's `TlsProfile(...)` constructor does.
fn build(options: NativeTlsProfileOptions) -> napi::Result<TlsProfile> {
    let list16 = |values: &Option<Vec<u32>>, name: &str| -> napi::Result<Vec<u16>> {
        u16_list(values.as_deref().unwrap_or_default(), name)
    };
    let extensions = options
        .extensions
        .unwrap_or_default()
        .into_iter()
        .map(extension)
        .collect::<napi::Result<Vec<_>>>()?;
    Ok(TlsProfile {
        tls_min_version: version(options.tls_min_version.as_deref(), TlsVersion::Tls12)?,
        tls_max_version: version(options.tls_max_version.as_deref(), TlsVersion::Tls13)?,
        cipher_suites: list16(&options.cipher_suites, "cipherSuites")?,
        extensions,
        supported_groups: list16(&options.supported_groups, "supportedGroups")?,
        signature_algorithms: list16(&options.signature_algorithms, "signatureAlgorithms")?,
        ec_point_formats: match &options.ec_point_formats {
            Some(formats) => u8_list(formats, "ecPointFormats")?,
            None => vec![0],
        },
        compression_methods: match &options.compression_methods {
            Some(methods) => u8_list(methods, "compressionMethods")?,
            None => vec![0],
        },
        grease: options.grease.map(grease).unwrap_or_default(),
        padding: options
            .padding
            .map(padding)
            .transpose()?
            .unwrap_or_default(),
        alps_protocols: options.alps_protocols,
        compress_cert_algorithms: options
            .compress_cert_algorithms
            .map(|values| u16_list(&values, "compressCertAlgorithms"))
            .transpose()?,
        key_share_curves: list16(&options.key_share_curves, "keyShareCurves")?,
        record_size_limit: options
            .record_size_limit
            .map(|value| {
                u16::try_from(value).map_err(|_| invalid_arg("recordSizeLimit is out of range"))
            })
            .transpose()?,
        delegated_credentials: options
            .delegated_credentials_sig_algs
            .map(|values| {
                u16_list(&values, "delegatedCredentialsSigAlgs").map(|signature_algorithms| {
                    DelegatedCredentialConfig {
                        signature_algorithms,
                    }
                })
            })
            .transpose()?,
        session_id_length: u8::try_from(options.session_id_length.unwrap_or(32))
            .map_err(|_| invalid_arg("sessionIdLength must be between 0 and 255"))?,
        alpn_protocols: options
            .alpn_protocols
            .unwrap_or_else(|| vec!["h2".to_owned(), "http/1.1".to_owned()]),
        randomization: options
            .shuffle_extensions
            .map(|shuffle_extensions| RandomizationConfig { shuffle_extensions }),
        name: options.name,
        session_resumption: Default::default(),
        tls_client_hello_style: Default::default(),
        ech: None,
        ech_outer_extensions: None,
    })
}

/// A TLS version by name, or `default`.
fn version(name: Option<&str>, default: TlsVersion) -> napi::Result<TlsVersion> {
    match name {
        None => Ok(default),
        Some("tls10") => Ok(TlsVersion::Tls10),
        Some("tls11") => Ok(TlsVersion::Tls11),
        Some("tls12") => Ok(TlsVersion::Tls12),
        Some("tls13") => Ok(TlsVersion::Tls13),
        Some(other) => Err(invalid_arg(format!(
            "unknown TLS version {other:?}; expected tls10, tls11, tls12 or tls13"
        ))),
    }
}

/// One extension of a hand-built profile.
fn extension(spec: NativeExtensionSpec) -> napi::Result<ExtensionSpec> {
    let extension_type = u16::try_from(spec.extension_type)
        .map_err(|_| invalid_arg("extensionType must be between 0 and 65535"))?;
    let source = match spec.source.as_deref().unwrap_or("auto") {
        "auto" => ExtensionSource::Auto,
        "grease" => ExtensionSource::Grease,
        "raw_bytes" => ExtensionSource::RawBytes {
            data: spec
                .raw_data
                .ok_or_else(|| invalid_arg("rawData (hex) is required for source raw_bytes"))?,
        },
        "trust_anchor_ids" => ExtensionSource::TrustAnchorIds {
            ids: spec.trust_anchor_ids.ok_or_else(|| {
                invalid_arg("trustAnchorIds (hex strings) is required for source trust_anchor_ids")
            })?,
            shuffle: spec.shuffle.unwrap_or(false),
        },
        other => {
            return Err(invalid_arg(format!(
                "unknown extension source {other:?}; expected auto, grease, raw_bytes or \
                 trust_anchor_ids"
            )));
        }
    };
    Ok(ExtensionSpec {
        extension_type,
        source,
    })
}

/// The GREASE switches, off unless set.
fn grease(options: NativeGrease) -> GreaseConfig {
    GreaseConfig {
        cipher_suite: options.cipher_suite.unwrap_or(false),
        extensions: options.extensions.unwrap_or(false),
        supported_groups: options.supported_groups.unwrap_or(false),
        supported_versions: options.supported_versions.unwrap_or(false),
        signature_algorithms: options.signature_algorithms.unwrap_or(false),
        key_share: options.key_share.unwrap_or(false),
    }
}

/// A padding strategy.
fn padding(options: NativePadding) -> napi::Result<PaddingStrategy> {
    let length = |value: Option<u32>, name: &str| {
        value
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| invalid_arg(format!("padding.{name} is required (0 to 65535)")))
    };
    match options.mode.as_str() {
        "block_align" => Ok(PaddingStrategy::BlockAlign {
            min_length: length(options.min_length, "minLength")?,
            block_size: length(options.block_size, "blockSize")?,
        }),
        "fixed_target" => Ok(PaddingStrategy::FixedTarget {
            target_length: length(options.target_length, "targetLength")?,
        }),
        "none" => Ok(PaddingStrategy::None),
        other => Err(invalid_arg(format!(
            "unknown padding {other:?}; expected block_align, fixed_target or none"
        ))),
    }
}
