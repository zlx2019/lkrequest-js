//! HSTS: whether `http://` URLs are upgraded to `https://` before connecting (RFC 6797).
//!
//! Wraps upstream's `NoHsts` / `StaticHsts` / `DynamicHsts`, and a policy written in
//! JavaScript, behind one class. Unlike lkrequest-py, which builds a fresh policy for every
//! session, a policy object is shared: a dynamic policy given to several sessions learns
//! `Strict-Transport-Security` hosts for all of them, like one browser profile.
//!
//! Upstream's `HstsPolicy` is a synchronous trait called from inside request futures, so a
//! JavaScript policy goes through the blocking bridge. It is asked only for `http://` URLs and
//! when a response carries the header, which keeps the round trips rare.

use std::sync::Arc;
use std::time::Duration;

use lkrequest::{DynamicHsts, HstsPolicy, NoHsts, StaticHsts};
use napi::bindgen_prelude::FnArgs;
use napi_derive::napi;

use crate::bridge::callback::{JsFn, call_blocking};

/// How long a JavaScript policy may take to answer before the host is left alone.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(30);

/// A JavaScript `shouldUpgrade(host)`, resolving with whether to upgrade. The facade wraps the
/// user's synchronous function so that it always returns a Promise. Weak, so a session's policy
/// never keeps the process alive.
type ShouldUpgradeFn = JsFn<String, bool, true>;

/// A JavaScript `recordSts(host, header)`.
type RecordStsFn = JsFn<FnArgs<(String, String)>, (), true>;

/// The native HSTS policy behind the public `Hsts`.
#[napi]
pub struct NativeHsts {
    policy: Arc<dyn HstsPolicy>,
}

#[napi]
impl NativeHsts {
    /// A policy that never upgrades, which is also the default.
    #[napi(factory)]
    pub fn none() -> Self {
        Self::from_policy(NoHsts)
    }

    /// Upgrades a fixed set of hosts (and their subdomains), optionally also every host
    /// under a top-level domain that Chrome preloads in full (`.dev`, `.app`, ...).
    #[napi(factory, js_name = "static")]
    pub fn fixed(hosts: Vec<String>, preloaded_tlds: Option<bool>) -> Self {
        let policy = StaticHsts::new(hosts);
        if preloaded_tlds == Some(true) {
            Self::from_policy(policy.with_preloaded_tlds())
        } else {
            Self::from_policy(policy)
        }
    }

    /// Learns hosts from `Strict-Transport-Security` response headers, optionally seeded with
    /// hosts already known to use HSTS.
    #[napi(factory)]
    pub fn dynamic(seed: Option<Vec<String>>) -> Self {
        match seed {
            Some(seed) if !seed.is_empty() => Self::from_policy(DynamicHsts::with_seed(seed)),
            _ => Self::from_policy(DynamicHsts::new()),
        }
    }

    /// A policy written in JavaScript. `recordSts` is optional; without it nothing is learned.
    #[napi(factory)]
    pub fn custom(
        #[napi(ts_arg_type = "(host: string) => Promise<boolean>")] should_upgrade: ShouldUpgradeFn,
        #[napi(ts_arg_type = "((host: string, header: string) => Promise<void>) | undefined")]
        record_sts: Option<RecordStsFn>,
    ) -> Self {
        Self::from_policy(JsHsts {
            should_upgrade,
            record_sts,
        })
    }

    /// Whether a request to `host` would be upgraded to `https://`. A JavaScript policy cannot
    /// be asked from the JavaScript thread (it would wait for itself); the facade answers
    /// those without coming here.
    #[napi]
    pub fn should_upgrade(&self, host: String) -> bool {
        self.policy.should_upgrade(&host)
    }
}

impl NativeHsts {
    /// Wraps an upstream policy.
    fn from_policy(policy: impl HstsPolicy + 'static) -> Self {
        Self {
            policy: Arc::new(policy),
        }
    }

    /// A handle to hand to a session builder; it shares this policy's state.
    pub(crate) fn shared(&self) -> SharedHsts {
        SharedHsts(Arc::clone(&self.policy))
    }
}

/// A policy shared between the `Hsts` object and every session it was given to.
pub(crate) struct SharedHsts(Arc<dyn HstsPolicy>);

impl HstsPolicy for SharedHsts {
    fn should_upgrade(&self, host: &str) -> bool {
        self.0.should_upgrade(host)
    }

    fn record_sts(&self, host: &str, sts_header: &str) {
        self.0.record_sts(host, sts_header);
    }
}

/// Upstream's HSTS trait backed by JavaScript functions.
struct JsHsts {
    should_upgrade: ShouldUpgradeFn,
    record_sts: Option<RecordStsFn>,
}

impl HstsPolicy for JsHsts {
    /// Asks the JavaScript function; anything but a clear "yes" leaves the host alone.
    fn should_upgrade(&self, host: &str) -> bool {
        match call_blocking(&self.should_upgrade, host.to_owned(), CALLBACK_TIMEOUT) {
            Ok(upgrade) => upgrade,
            Err(err) => {
                tracing::warn!(
                    target: "lkrequest_napi::bridge",
                    host,
                    error = %err,
                    "hsts shouldUpgrade failed; not upgrading"
                );
                false
            }
        }
    }

    /// Tells the JavaScript function about a header. It is waited for, so that a later
    /// `should_upgrade` on this thread's behalf sees what it recorded.
    fn record_sts(&self, host: &str, sts_header: &str) {
        let Some(record) = &self.record_sts else {
            return;
        };
        let args = FnArgs::from((host.to_owned(), sts_header.to_owned()));
        if let Err(err) = call_blocking(record, args, CALLBACK_TIMEOUT) {
            tracing::warn!(
                target: "lkrequest_napi::bridge",
                host,
                error = %err,
                "hsts recordSts failed"
            );
        }
    }
}
