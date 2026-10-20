//! Proxies: immutable `ProxyConfig` values (single proxies and multi-hop chains) and the
//! `ProxyPool` that rotates through them, with leases that hold a pool permit.
//!
//! Ported from lkrequest-py's `src/proxy.rs`. Unlike Python, `acquire()` hands out a lease
//! (upstream's `ProxyGuard`) instead of an identity string, so the caller keeps the permit and
//! can mark exactly that proxy bad.

use std::sync::{Mutex, PoisonError};

use std::sync::Arc;
use std::time::Duration;

use lkrequest::dns::SystemDns;
use lkrequest::proxy::{ProxyAuthHeader, ProxyAuthenticator, ProxyConfig, RotationStrategy};
use lkrequest::{BadProxyConfig, HealthCheckConfig, ProxyGuard, ProxyPool};
use napi::Env;
use napi::bindgen_prelude::{AsyncBlock, AsyncBlockBuilder, ClassInstance};
use napi_derive::napi;

use crate::bridge::callback::{JsFn, call_blocking};
use crate::bridge::cancel::{AbortHandle, until_cancelled};
use crate::bridge::inflight::{Delivered, InFlightGuard};
use crate::client::NativeClient;
use crate::error::{NativeError, invalid_arg};
use crate::masque::{self, NativeMasqueOptions};
use crate::proxy_source::{FACTORY_TIMEOUT, JsProxyProvider, ProxyFactoryFn};
use crate::runtime;
use crate::types::{duration_from_ms, usize_from};

/// The host a proxy health check tunnels to unless told otherwise, as in a pool's checks.
const PROBE_HOST: &str = "www.google.com";
/// The port a proxy health check tunnels to unless told otherwise.
const PROBE_PORT: u16 = 443;
/// How long a single health check may take unless told otherwise.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// A JavaScript function giving the value of the authorization header, or nothing. Weak, so a
/// proxy's credential never keeps the process alive.
type AuthorizeFn = JsFn<(), Option<String>, true>;

/// How long the credential function may take before the connection goes without one.
const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(30);

/// Upstream's authenticator trait backed by a JavaScript function.
///
/// Upstream asks for the header on connecting, in a Tokio task (and more than once per
/// connection), so the blocking bridge applies. Its `identity_fragment`, on the other hand,
/// can be asked on the JavaScript thread (`ProxyConfig::identity`), which is why the identity
/// is a plain string.
struct JsAuthenticator {
    identity: String,
    authorize: AuthorizeFn,
}

impl ProxyAuthenticator for JsAuthenticator {
    fn identity_fragment(&self) -> String {
        self.identity.clone()
    }

    /// Asks the JavaScript function; a failure sends no credential, which a proxy that wants
    /// one answers with an error the caller sees.
    fn authorization_value(&self) -> Option<String> {
        match call_blocking(&self.authorize, (), AUTHORIZE_TIMEOUT) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(
                    target: "lkrequest_napi::bridge",
                    identity = %self.identity,
                    error = %err,
                    "the proxy credential function failed; connecting without one"
                );
                None
            }
        }
    }
}

/// A proxy, or a chain of proxies, to route requests through.
#[napi]
pub struct NativeProxyConfig {
    pub(crate) inner: ProxyConfig,
}

#[napi]
impl NativeProxyConfig {
    /// Parses an `http://`, `socks5://`, `socks5h://` or `masque://` proxy URL.
    #[napi(factory, catch_unwind)]
    pub fn parse(url: String) -> napi::Result<Self> {
        let inner = ProxyConfig::parse(&url)
            .map_err(|err| invalid_arg(format!("invalid proxy {url:?}: {err}")))?;
        Ok(Self { inner })
    }

    /// Builds a chain from the hop the client connects to first through to the last hop.
    #[napi(factory, catch_unwind)]
    pub fn parse_chain(urls: Vec<String>) -> napi::Result<Self> {
        let inner = ProxyConfig::parse_chain(&urls)
            .map_err(|err| invalid_arg(format!("invalid proxy chain: {err}")))?;
        Ok(Self { inner })
    }

    /// A copy routed through `hops` first: `hops[0]`, ..., the last hop, then this proxy.
    #[napi]
    pub fn through(&self, hops: Vec<ClassInstance<'_, NativeProxyConfig>>) -> Self {
        let hops = hops.iter().map(|hop| hop.inner.clone()).collect();
        Self {
            inner: self.inner.clone().through(hops),
        }
    }

    /// A copy authenticating with a user name and password, replacing any credential.
    #[napi]
    pub fn with_user_pass(&self, username: String, password: String) -> napi::Result<Self> {
        let inner = self
            .inner
            .clone()
            .with_user_pass(&username, &password)
            .map_err(|err| invalid_arg(err.to_string()))?;
        Ok(Self { inner })
    }

    /// A copy sending `<scheme> <credentials>` in an HTTP header, replacing any credential.
    #[napi]
    pub fn with_http_auth(&self, scheme: String, credentials: String) -> napi::Result<Self> {
        let inner = self
            .inner
            .clone()
            .with_http_auth(&scheme, &credentials)
            .map_err(|err| invalid_arg(err.to_string()))?;
        Ok(Self { inner })
    }

    /// A copy whose credential is computed by a JavaScript function on every connection.
    /// `identity` is a stable, non-secret string that tells this credential apart from others
    /// on the same proxy address; it becomes part of the proxy's identity.
    #[napi]
    pub fn with_custom_auth(
        &self,
        identity: String,
        #[napi(ts_arg_type = "() => Promise<string | null | undefined>")] authorize: AuthorizeFn,
    ) -> napi::Result<Self> {
        let authenticator = Arc::new(JsAuthenticator {
            identity,
            authorize,
        });
        let inner = self
            .inner
            .clone()
            .with_custom_auth(authenticator)
            .map_err(|err| invalid_arg(err.to_string()))?;
        Ok(Self { inner })
    }

    /// A copy sending the credential in `proxy-authorization` or `authorization`.
    #[napi]
    pub fn with_auth_header(&self, header: String) -> napi::Result<Self> {
        let header = match header.to_ascii_lowercase().as_str() {
            "proxy-authorization" => ProxyAuthHeader::ProxyAuthorization,
            "authorization" => ProxyAuthHeader::Authorization,
            _ => {
                return Err(invalid_arg(format!(
                    "unknown proxy auth header {header:?}; expected proxy-authorization or \
                     authorization"
                )));
            }
        };
        Ok(Self {
            inner: self.inner.clone().with_auth_header(header),
        })
    }

    /// Number of hops: 1 for a single proxy.
    #[napi(getter)]
    pub fn hop_count(&self) -> u32 {
        u32::try_from(self.inner.hop_count()).unwrap_or(u32::MAX)
    }

    /// Host of the proxy the client talks to last: the only one, or a chain's final hop.
    #[napi(getter)]
    pub fn host(&self) -> String {
        self.inner.host_port().0.to_owned()
    }

    /// Port of the proxy the client talks to last.
    #[napi(getter)]
    pub fn port(&self) -> u32 {
        u32::from(self.inner.host_port().1)
    }

    /// Whether a failure on this route must never fall back to a direct connection, which is
    /// the case when a MASQUE proxy is involved.
    #[napi(getter)]
    pub fn forbids_direct_fallback(&self) -> bool {
        self.inner.forbids_direct_fallback()
    }

    /// Opens a tunnel to the target through the proxy and closes it again. Resolves with the
    /// time it took, or with the error; never rejects for a failed check.
    ///
    /// Names are resolved with `client`'s resolver when it is given, else the system's. The
    /// check counts as in flight from this call until its result has been delivered.
    #[napi(ts_return_type = "Promise<NativeProbeOutcome>")]
    pub fn health_check(
        &self,
        env: Env,
        options: Option<NativeProbeOptions>,
        client: Option<&NativeClient>,
    ) -> napi::Result<AsyncBlock<Delivered<NativeProbeOutcome>>> {
        let options = options.unwrap_or(NativeProbeOptions {
            host: None,
            port: None,
            timeout: None,
        });
        let host = options.host.unwrap_or_else(|| PROBE_HOST.to_owned());
        let port = options.port.unwrap_or(PROBE_PORT);
        let timeout = match options.timeout {
            Some(ms) => duration_from_ms(ms, "timeout")?,
            None => PROBE_TIMEOUT,
        };
        let guard = InFlightGuard::register();
        let proxy = self.inner.clone();
        let client = client.map(|client| client.inner.clone());
        let work = async move {
            let started = std::time::Instant::now();
            let result = match &client {
                Some(client) => {
                    proxy
                        .health_check(&host, port, timeout, client.resolver())
                        .await
                }
                None => proxy.health_check(&host, port, timeout, &SystemDns).await,
            };
            let outcome = match result {
                Ok(_) => NativeProbeOutcome {
                    latency: Some(started.elapsed().as_secs_f64() * 1000.0),
                    error: None,
                },
                Err(err) => NativeProbeOutcome {
                    latency: None,
                    error: Some(NativeError::from_upstream(&err)),
                },
            };
            Ok(Delivered::new(outcome, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }

    /// Stable key for pooling and failure tracking; it leaves passwords out.
    #[napi(getter)]
    pub fn identity(&self) -> String {
        self.inner.identity()
    }

    /// The proxy endpoint, readable and without secrets.
    #[napi(js_name = "toString")]
    pub fn describe(&self) -> String {
        self.inner.to_string()
    }
}

/// Where and how long to probe a proxy; the time is in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeProbeOptions {
    /// Host to tunnel to through the proxy (default `www.google.com`).
    pub host: Option<String>,
    /// Port to tunnel to (default 443).
    pub port: Option<u16>,
    /// Time limit of the check (default 5000).
    pub timeout: Option<f64>,
}

/// How a proxy health check ended.
#[napi(object, object_from_js = false)]
pub struct NativeProbeOutcome {
    /// Time the tunnel took to open, in milliseconds.
    pub latency: Option<f64>,
    /// Why the tunnel could not be opened.
    pub error: Option<NativeError>,
}

/// How a proxy pool cools failing proxies down; durations in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeBadProxyOptions {
    /// Failures within `window` that make a proxy bad (default 3).
    pub failure_threshold: Option<u32>,
    /// Window failures are counted in (default 60000).
    pub window: Option<f64>,
    /// How long a bad proxy is skipped (default 300000).
    pub cooldown: Option<f64>,
    /// Cooldowns after which a proxy is dropped for good (default 5).
    pub max_cooldowns: Option<u32>,
}

/// Periodic proxy health checks; durations in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeHealthCheckOptions {
    /// Time between checks (default 60000).
    pub interval: Option<f64>,
    /// Time limit of one check (default 5000).
    pub timeout: Option<f64>,
    /// Host the check connects to through each proxy (default `www.google.com`).
    pub target_host: Option<String>,
    /// Port the check connects to (default 443).
    pub target_port: Option<u16>,
    /// Probe MASQUE proxies by opening a real CONNECT-UDP tunnel to the target (needs
    /// `masque`); without it they are skipped, neither credited nor blacklisted.
    pub tunnel_probe: Option<bool>,
    /// How to reach MASQUE proxies for the probe.
    pub masque: Option<NativeMasqueOptions>,
}

/// Options of a proxy pool.
#[napi(object, object_to_js = false)]
pub struct NativeProxyPoolOptions {
    /// Most proxies leased out at once.
    pub max_concurrent: Option<f64>,
    /// `round_robin` (default) or `random`.
    pub rotation: Option<String>,
    /// Bad-proxy detection.
    pub bad_proxy: Option<NativeBadProxyOptions>,
    /// Periodic health checks.
    pub health_check: Option<NativeHealthCheckOptions>,
    /// Proxies a function source keeps ready, made up ahead of `acquire()`.
    pub proxy_buffer: Option<f64>,
}

/// A pool of proxies handed out in rotation, skipping bad ones.
#[napi]
pub struct NativeProxyPool {
    inner: ProxyPool,
}

#[napi]
impl NativeProxyPool {
    /// Builds a pool; health checks, when configured, start in the background.
    #[napi(constructor, catch_unwind)]
    pub fn new(
        proxies: Vec<ClassInstance<'_, NativeProxyConfig>>,
        options: Option<NativeProxyPoolOptions>,
    ) -> napi::Result<Self> {
        let proxies = proxies.iter().map(|proxy| proxy.inner.clone()).collect();
        let mut builder = ProxyPool::builder().proxies(proxies);
        if let Some(options) = options {
            if let Some(n) = options.max_concurrent {
                builder = builder.max_proxies(usize_from(n, "maxConcurrent")?);
            }
            if let Some(name) = &options.rotation {
                builder = builder.rotation(rotation(name)?);
            }
            if let Some(bad) = &options.bad_proxy {
                builder = builder.bad_proxy_config(bad_proxy_config(bad)?);
            }
            if let Some(check) = &options.health_check {
                builder = builder.health_check(health_check_config(check)?);
            }
        }
        // Inside the runtime, building starts the health checks at once; outside it, upstream
        // would wait for the first acquire().
        let inner = runtime::enter(|| builder.build());
        Ok(Self { inner })
    }

    /// Builds a pool whose proxies a JavaScript function makes up, one per lease.
    #[napi(factory, catch_unwind)]
    pub fn from_factory(
        #[napi(ts_arg_type = "(slot: NativeProxySlot) => Promise<void>")] factory: ProxyFactoryFn,
        options: Option<NativeProxyPoolOptions>,
    ) -> napi::Result<Self> {
        let mut builder = ProxyPool::builder();
        let mut buffer = 0;
        if let Some(options) = options {
            if options.rotation.is_some()
                || options.bad_proxy.is_some()
                || options.health_check.is_some()
            {
                return Err(invalid_arg(
                    "rotation, badProxy and healthCheck do not apply to proxies made up by a function",
                ));
            }
            if let Some(n) = options.max_concurrent {
                builder = builder.max_proxies(usize_from(n, "maxConcurrent")?);
            }
            if let Some(n) = options.proxy_buffer {
                buffer = usize_from(n, "proxyBuffer")?;
            }
        }
        // The provider spawns its buffer's refill task.
        let inner = runtime::enter(|| {
            builder
                .proxy_provider(JsProxyProvider::new(factory, FACTORY_TIMEOUT, buffer))
                .build()
        });
        Ok(Self { inner })
    }

    /// Waits for a proxy permit and leases the next proxy, waiting too while no proxy is
    /// usable. Resolves with `null` when `abort` fires first.
    #[napi(ts_return_type = "Promise<NativeProxyLease | null>")]
    pub fn acquire(
        &self,
        env: Env,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeProxyLease>>>> {
        let guard = InFlightGuard::register();
        let pool = self.inner.clone();
        let token = abort.map(AbortHandle::token);
        let work = async move {
            // Dropping the cancelled acquisition gives its permit back.
            let lease = until_cancelled(token.as_deref(), pool.acquire())
                .await
                .map(|lease| {
                    tracing::debug!(
                        proxy = ?lease.proxy().map(ProxyConfig::identity),
                        "proxy_pool.acquire"
                    );
                    NativeProxyLease::new(lease)
                });
            Ok(Delivered::new(lease, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }

    /// Most proxies that can be leased out at once.
    #[napi(getter)]
    pub fn max_concurrent(&self) -> u32 {
        u32::try_from(self.inner.max_concurrent()).unwrap_or(u32::MAX)
    }

    /// Marks `bad`'s proxy as failing, gives its permit back, and leases the next proxy, as
    /// `acquire()` does.
    #[napi(ts_return_type = "Promise<NativeProxyLease | null>")]
    pub fn acquire_fresh(
        &self,
        env: Env,
        bad: &NativeProxyLease,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeProxyLease>>>> {
        // Upstream waits for a new permit while the old lease still holds one, which never
        // ends with a single slot; the permit goes back first.
        bad.mark_bad();
        bad.release();
        self.acquire(env, abort)
    }

    /// Marks the proxy with this identity as failing.
    #[napi]
    pub fn mark_bad(&self, identity: String) {
        tracing::info!(proxy = %identity, "proxy_pool.mark_bad");
        self.inner.mark_bad_proxy(&identity);
    }
}

/// A leased proxy; the pool permit is held until it is released.
#[napi]
pub struct NativeProxyLease {
    guard: Mutex<Option<ProxyGuard>>,
}

#[napi]
impl NativeProxyLease {
    /// The leased proxy, absent once released or when the pool has no proxies.
    #[napi(getter)]
    pub fn proxy(&self) -> Option<NativeProxyConfig> {
        let guard = self.guard.lock().unwrap_or_else(PoisonError::into_inner);
        let inner = guard.as_ref()?.proxy()?.clone();
        Some(NativeProxyConfig { inner })
    }

    /// Reports the leased proxy as failing.
    #[napi]
    pub fn mark_bad(&self) {
        if let Some(lease) = &*self.guard.lock().unwrap_or_else(PoisonError::into_inner) {
            lease.mark_bad();
        }
    }

    /// Gives the permit back; later calls do nothing.
    #[napi]
    pub fn release(&self) {
        self.guard
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

impl NativeProxyLease {
    /// Wraps an upstream guard.
    fn new(guard: ProxyGuard) -> Self {
        Self {
            guard: Mutex::new(Some(guard)),
        }
    }
}

/// A rotation strategy by name.
pub(crate) fn rotation(name: &str) -> napi::Result<RotationStrategy> {
    match name {
        "round_robin" => Ok(RotationStrategy::RoundRobin),
        "random" => Ok(RotationStrategy::Random),
        _ => Err(invalid_arg(format!(
            "unknown rotation {name:?}; expected round_robin or random"
        ))),
    }
}

/// Upstream's bad-proxy settings, with lkrequest-py's defaults.
pub(crate) fn bad_proxy_config(options: &NativeBadProxyOptions) -> napi::Result<BadProxyConfig> {
    let defaults = BadProxyConfig::default();
    Ok(BadProxyConfig {
        failure_threshold: options
            .failure_threshold
            .unwrap_or(defaults.failure_threshold),
        window: match options.window {
            Some(ms) => duration_from_ms(ms, "badProxy.window")?,
            None => defaults.window,
        },
        cooldown_duration: match options.cooldown {
            Some(ms) => duration_from_ms(ms, "badProxy.cooldown")?,
            None => defaults.cooldown_duration,
        },
        max_cooldowns: options.max_cooldowns.unwrap_or(defaults.max_cooldowns),
    })
}

/// Upstream's health-check settings. The struct is `#[non_exhaustive]`, so the defaults are
/// overwritten field by field.
pub(crate) fn health_check_config(
    options: &NativeHealthCheckOptions,
) -> napi::Result<HealthCheckConfig> {
    let mut config = HealthCheckConfig::default();
    if let Some(ms) = options.interval {
        config.interval = duration_from_ms(ms, "healthCheck.interval")?;
    }
    if let Some(ms) = options.timeout {
        config.timeout = duration_from_ms(ms, "healthCheck.timeout")?;
    }
    if let Some(host) = &options.target_host {
        config.target_host = host.clone();
    }
    if let Some(port) = options.target_port {
        config.target_port = port;
    }
    masque::apply_to_health_check(&mut config, options.tunnel_probe, options.masque.as_ref())?;
    Ok(config)
}
