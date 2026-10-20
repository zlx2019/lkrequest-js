//! Session pools: sessions over a set of proxies, leased out and returned for reuse.
//!
//! Ported from lkrequest-py's `src/session_pool.rs`. A session goes back to its pool when the
//! lease's `SessionGuard` drops, on any thread, unless the lease was marked bad: upstream then
//! discards the session and frees its proxy permit.

use std::sync::{Mutex, PoisonError};

use lkrequest::{SessionGuard, SessionPool};
use napi::Env;
use napi::bindgen_prelude::{AsyncBlock, AsyncBlockBuilder, ClassInstance};
use napi_derive::napi;

use crate::bridge::cancel::{AbortHandle, until_cancelled};
use crate::bridge::inflight::{Delivered, InFlightGuard};
use crate::client::NativeClient;
use crate::error::invalid_arg;
use crate::proxy::{
    NativeBadProxyOptions, NativeHealthCheckOptions, NativeProxyConfig, bad_proxy_config,
    health_check_config, rotation,
};
use crate::proxy_source::{FACTORY_TIMEOUT, JsProxyProvider, ProxyFactoryFn};
use crate::runtime;
use crate::session::NativeSession;
use crate::types::{duration_from_ms, usize_from};

/// Options of a session pool.
#[napi(object, object_to_js = false)]
pub struct NativeSessionPoolOptions {
    /// Largest number of sessions alive at once.
    pub max_sessions: Option<f64>,
    /// How long an idle session is kept, in milliseconds.
    pub idle_timeout: Option<f64>,
    /// `round_robin` (default) or `random`.
    pub rotation: Option<String>,
    /// Bad-proxy detection.
    pub bad_proxy: Option<NativeBadProxyOptions>,
    /// Periodic health checks.
    pub health_check: Option<NativeHealthCheckOptions>,
    /// Proxies a function source keeps ready, made up ahead of `acquire()`.
    pub proxy_buffer: Option<f64>,
}

/// Session pool statistics.
#[napi(object, object_from_js = false)]
pub struct NativeSessionPoolStats {
    /// Sessions waiting to be leased again.
    pub idle_sessions: u32,
    /// Largest number of sessions alive at once.
    pub max_sessions: u32,
}

/// A pool of sessions, each bound to one of the pool's proxies.
#[napi]
pub struct NativeSessionPool {
    inner: SessionPool,
}

#[napi]
impl NativeSessionPool {
    /// Builds a pool of `client`'s sessions over `proxies`.
    #[napi(constructor, catch_unwind)]
    pub fn new(
        client: &NativeClient,
        proxies: Vec<ClassInstance<'_, NativeProxyConfig>>,
        options: Option<NativeSessionPoolOptions>,
    ) -> napi::Result<Self> {
        let proxies = proxies.iter().map(|proxy| proxy.inner.clone()).collect();
        let mut builder = SessionPool::builder()
            .client(&client.inner)
            .proxies(proxies);
        if let Some(options) = options {
            if let Some(n) = options.max_sessions {
                builder = builder.max_sessions(usize_from(n, "maxSessions")?);
            }
            if let Some(ms) = options.idle_timeout {
                builder = builder.idle_timeout(duration_from_ms(ms, "idleTimeout")?);
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
        // Inside the runtime, building starts the health checks and the idle eviction at once;
        // outside it, upstream would wait for the first acquire().
        let inner = runtime::enter(|| builder.build());
        Ok(Self { inner })
    }

    /// Builds a pool of `client`'s sessions whose proxies a JavaScript function makes up, one
    /// per session.
    #[napi(factory, catch_unwind)]
    pub fn from_factory(
        client: &NativeClient,
        #[napi(ts_arg_type = "(slot: NativeProxySlot) => Promise<void>")] factory: ProxyFactoryFn,
        options: Option<NativeSessionPoolOptions>,
    ) -> napi::Result<Self> {
        let mut builder = SessionPool::builder().client(&client.inner);
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
            if let Some(n) = options.max_sessions {
                builder = builder.max_sessions(usize_from(n, "maxSessions")?);
            }
            if let Some(ms) = options.idle_timeout {
                builder = builder.idle_timeout(duration_from_ms(ms, "idleTimeout")?);
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

    /// Waits for a free session and leases it, waiting too while no proxy is usable. Resolves
    /// with `null` when `abort` fires first.
    #[napi(ts_return_type = "Promise<NativeSessionLease | null>")]
    pub fn acquire(
        &self,
        env: Env,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeSessionLease>>>> {
        self.lease(env, abort)
    }

    /// Marks `bad`'s session as failing, discards it, and leases another, as `acquire()` does.
    #[napi(ts_return_type = "Promise<NativeSessionLease | null>")]
    pub fn acquire_fresh(
        &self,
        env: Env,
        bad: &NativeSessionLease,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeSessionLease>>>> {
        // Discarded before waiting: with `maxSessions: 1` the old lease holds the only slot.
        bad.mark_bad();
        bad.release();
        self.lease(env, abort)
    }

    /// Current pool statistics.
    #[napi(ts_return_type = "Promise<NativeSessionPoolStats>")]
    pub fn stats(&self, env: Env) -> napi::Result<AsyncBlock<Delivered<NativeSessionPoolStats>>> {
        let guard = InFlightGuard::register();
        let pool = self.inner.clone();
        let work = async move {
            let stats = pool.stats().await;
            let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
            let stats = NativeSessionPoolStats {
                idle_sessions: count(stats.idle_sessions),
                max_sessions: count(stats.max_sessions),
            };
            Ok(Delivered::new(stats, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }
}

impl NativeSessionPool {
    /// Leases a session, or resolves with `null` once `abort` fires.
    fn lease(
        &self,
        env: Env,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeSessionLease>>>> {
        let guard = InFlightGuard::register();
        let pool = self.inner.clone();
        let token = abort.map(AbortHandle::token);
        let work = async move {
            // Dropping the cancelled acquisition gives its permit back.
            let acquired = until_cancelled(token.as_deref(), pool.acquire()).await;
            let lease = acquired.map(|session| {
                tracing::debug!("session_pool.acquire");
                NativeSessionLease::new(pool, session)
            });
            Ok(Delivered::new(lease, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }
}

/// A leased session; it goes back to the pool when released or garbage collected.
#[napi]
pub struct NativeSessionLease {
    pool: SessionPool,
    guard: Mutex<Option<SessionGuard>>,
}

#[napi]
impl NativeSessionLease {
    /// The leased session; fails once the lease has been released.
    #[napi]
    pub fn session(&self) -> napi::Result<NativeSession> {
        let guard = self.guard.lock().unwrap_or_else(PoisonError::into_inner);
        let session = guard
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("the session lease has been released"))?;
        Ok(NativeSession {
            inner: (**session).clone(),
        })
    }

    /// Reports the session's proxy as failing; upstream discards the session on release.
    #[napi]
    pub fn mark_bad(&self) {
        if let Some(session) = &*self.guard.lock().unwrap_or_else(PoisonError::into_inner) {
            self.pool.mark_bad(session);
        }
    }

    /// Gives the session back to the pool, or discards it when marked bad; later calls do
    /// nothing. A lease nobody released is given back when it is garbage collected.
    #[napi]
    pub fn release(&self) {
        self.guard
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

impl NativeSessionLease {
    /// Wraps an upstream guard.
    fn new(pool: SessionPool, guard: SessionGuard) -> Self {
        Self {
            pool,
            guard: Mutex::new(Some(guard)),
        }
    }
}
