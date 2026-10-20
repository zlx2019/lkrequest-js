//! QUIC / HTTP/3 profiles (`quic-h3` feature): transport parameters, HTTP/3 SETTINGS and
//! packet layout.
//!
//! Without the feature the class still exists, so the option types stay the same, but none
//! of its factories can create a profile.

#[cfg(not(feature = "quic-h3"))]
pub(crate) use disabled::*;
#[cfg(feature = "quic-h3")]
pub(crate) use enabled::*;

#[cfg(feature = "quic-h3")]
mod enabled {
    use lkrequest::QuicProfile;
    use lkrequest::lkh3;
    use napi_derive::napi;

    use crate::error::invalid_arg;
    use crate::fingerprint::{Presets, lookup, names};

    /// Every QUIC preset, by browser name.
    const PRESETS: &Presets<QuicProfile> = &[
        ("chrome", lkh3::chrome_quic),
        ("chrome_146", lkh3::chrome_146_quic),
        ("chrome_150", lkh3::chrome_150_quic),
        ("chrome_151", lkh3::chrome_151_quic),
        ("chrome_152", lkh3::chrome_152_quic),
        ("chrome_153", lkh3::chrome_153_quic),
        ("chrome_154", lkh3::chrome_154_quic),
        ("chrome_155", lkh3::chrome_155_quic),
    ];

    /// A QUIC / HTTP/3 fingerprint profile.
    #[napi]
    pub struct NativeQuicProfile {
        pub(crate) inner: QuicProfile,
    }

    #[napi]
    impl NativeQuicProfile {
        /// A preset by name (`chrome`, `chrome_155`, ...).
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

        /// A profile from its JSON form.
        #[napi(factory)]
        pub fn from_json(json: String) -> napi::Result<Self> {
            let inner = serde_json::from_str(&json)
                .map_err(|err| invalid_arg(format!("invalid QUIC profile JSON: {err}")))?;
            Ok(Self { inner })
        }

        /// The profile as JSON, in upstream's format.
        #[napi]
        pub fn to_json(&self) -> napi::Result<String> {
            serde_json::to_string(&self.inner).map_err(|err| {
                napi::Error::from_reason(format!("cannot serialize the profile: {err}"))
            })
        }

        /// Throws when the profile's settings contradict each other.
        #[napi]
        pub fn validate(&self) -> napi::Result<()> {
            self.inner.validate().map_err(invalid_arg)
        }

        /// Length of the connection IDs the client chooses.
        #[napi(getter)]
        pub fn connection_id_length(&self) -> u32 {
            u32::try_from(self.inner.connection_id_length).unwrap_or(u32::MAX)
        }
    }

    /// A QUIC preset by name.
    pub(crate) fn preset(name: &str) -> napi::Result<QuicProfile> {
        lookup(PRESETS, "QUIC profile", name)
    }
}

#[cfg(not(feature = "quic-h3"))]
mod disabled {
    use napi_derive::napi;

    use crate::error::invalid_arg;

    /// A QUIC / HTTP/3 fingerprint profile; this build has no QUIC support.
    #[napi]
    pub struct NativeQuicProfile {}

    #[napi]
    impl NativeQuicProfile {
        /// Always throws: QUIC is not compiled in.
        #[napi(factory)]
        pub fn preset(_name: String) -> napi::Result<Self> {
            Err(unavailable())
        }

        /// No presets without QUIC support.
        #[napi]
        pub fn preset_names() -> Vec<&'static str> {
            Vec::new()
        }

        /// Always throws: QUIC is not compiled in.
        #[napi(factory)]
        pub fn from_json(_json: String) -> napi::Result<Self> {
            Err(unavailable())
        }

        /// Unreachable: no instance can exist.
        #[napi]
        pub fn to_json(&self) -> napi::Result<String> {
            Err(unavailable())
        }

        /// Unreachable: no instance can exist.
        #[napi]
        pub fn validate(&self) -> napi::Result<()> {
            Err(unavailable())
        }

        /// Unreachable: no instance can exist.
        #[napi(getter)]
        pub fn connection_id_length(&self) -> u32 {
            0
        }
    }

    /// The error for using QUIC in a build without it.
    fn unavailable() -> napi::Error {
        invalid_arg("QuicProfile requires building lkrequest-js with the 'quic-h3' feature")
    }
}
