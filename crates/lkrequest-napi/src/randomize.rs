//! Fingerprint randomization policies (`Client({ randomize })`).
//!
//! `off` and `extension_order` stay a real browser. The synthetic tiers `recombine` and
//! `full` produce fingerprints that match no real browser and need the `synthetic-fp` feature;
//! each session then draws its own identity.

use lkrequest::Randomize;
#[cfg(feature = "synthetic-fp")]
use lkrequest::{Layers, NegotiabilityFloor};
use napi_derive::napi;

use crate::error::invalid_arg;

/// A randomization policy.
#[napi(object, object_to_js = false)]
pub struct NativeRandomize {
    /// `off`, `extension_order`, `recombine` or `full`.
    pub mode: String,
    /// Layers a synthetic policy varies: `tls`, `h2`, `quic` (default all).
    pub layers: Option<Vec<String>>,
    /// Signature algorithm floor of a synthetic policy: `universal` or `preset_family`.
    pub negotiability: Option<String>,
    /// A custom signature algorithm floor, instead of `negotiability`.
    pub negotiability_sig_algs: Option<Vec<u32>>,
}

/// The upstream policy `options` describe.
pub(crate) fn randomize(options: &NativeRandomize) -> napi::Result<Randomize> {
    match options.mode.as_str() {
        "off" | "extension_order" if options.layers.is_some() || has_floor(options) => Err(
            invalid_arg("layers and negotiability apply to the recombine and full modes only"),
        ),
        "off" => Ok(Randomize::off()),
        "extension_order" => Ok(Randomize::extension_order()),
        "recombine" | "full" => synthetic(options),
        other => Err(invalid_arg(format!(
            "unknown randomize mode {other:?}; expected off, extension_order, recombine or full"
        ))),
    }
}

/// Whether a negotiability floor was given.
fn has_floor(options: &NativeRandomize) -> bool {
    options.negotiability.is_some() || options.negotiability_sig_algs.is_some()
}

/// A synthetic policy.
#[cfg(feature = "synthetic-fp")]
fn synthetic(options: &NativeRandomize) -> napi::Result<Randomize> {
    let layers = match &options.layers {
        Some(names) => layers(names)?,
        None => Layers::all(),
    };
    let policy = if options.mode == "full" {
        Randomize::full_layers(layers)
    } else {
        Randomize::recombine_layers(layers)
    };
    let floor = match (&options.negotiability, &options.negotiability_sig_algs) {
        (None, None) => return Ok(policy),
        (Some(name), None) => match name.as_str() {
            "universal" => NegotiabilityFloor::Universal,
            "preset_family" => NegotiabilityFloor::PresetFamily,
            other => {
                return Err(invalid_arg(format!(
                    "unknown negotiability {other:?}; expected universal, preset_family or a \
                     list of signature algorithms"
                )));
            }
        },
        (None, Some(sig_algs)) => NegotiabilityFloor::Custom(
            sig_algs
                .iter()
                .map(|&value| {
                    u16::try_from(value)
                        .map_err(|_| invalid_arg("signature algorithms are 0 to 65535"))
                })
                .collect::<napi::Result<_>>()?,
        ),
        (Some(_), Some(_)) => {
            return Err(invalid_arg(
                "negotiability is either a name or a list of signature algorithms, not both",
            ));
        }
    };
    Ok(policy.negotiability(floor))
}

/// A synthetic policy in a build without the feature.
#[cfg(not(feature = "synthetic-fp"))]
fn synthetic(options: &NativeRandomize) -> napi::Result<Randomize> {
    Err(invalid_arg(format!(
        "randomize mode {:?} requires building lkrequest-js with the 'synthetic-fp' feature",
        options.mode
    )))
}

/// The layer mask for layer names.
#[cfg(feature = "synthetic-fp")]
fn layers(names: &[String]) -> napi::Result<Layers> {
    if names.is_empty() {
        return Err(invalid_arg(
            "layers must name at least one of tls, h2, quic",
        ));
    }
    names.iter().try_fold(Layers::empty(), |all, name| {
        let layer = match name.as_str() {
            "tls" => Layers::TLS,
            "h2" => Layers::H2,
            "quic" => Layers::QUIC,
            other => {
                return Err(invalid_arg(format!(
                    "unknown layer {other:?}; expected tls, h2 or quic"
                )));
            }
        };
        Ok(all | layer)
    })
}
