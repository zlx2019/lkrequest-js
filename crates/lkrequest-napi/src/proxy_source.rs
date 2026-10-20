//! Proxies produced by a JavaScript function, for the proxy and session pools.
//!
//! Upstream asks its `ProxyProvider` for the next proxy synchronously, from inside `acquire()`,
//! so the function is reached through the blocking bridge. With a buffer the binding keeps a
//! few proxies ready instead, filled by a Tokio task that awaits the function, so `acquire()`
//! rarely has to wait for JavaScript at all. Upstream's own `proxy_buffer` cannot do this: it
//! fills from a plain thread, where the bridge refuses to block.
//!
//! A function that fails makes the provider answer `None`. Upstream's pools then ask again
//! about every 100 milliseconds, so `acquire()` waits until the function gives a proxy; a
//! pool never hands out a lease without one, which would connect directly.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use lkrequest::proxy::{ProxyConfig, ProxyProvider};
use napi_derive::napi;
use tokio::sync::Notify;

use crate::bridge::callback::{CallbackError, JsFn, call, call_blocking};
use crate::error::invalid_arg;
use crate::proxy::NativeProxyConfig;

/// How long a call into the function may take before it counts as failed.
pub(crate) const FACTORY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the refill task waits after a failure before it asks again.
const REFILL_RETRY_DELAY: Duration = Duration::from_secs(1);

/// A JavaScript function that leaves its proxy in the slot it is given. Weak, so a pool never
/// keeps the process alive.
///
/// The proxy cannot be the function's return value: a native object can only be borrowed
/// while napi-rs converts the arguments of a call into Rust, which a returned value is not.
pub(crate) type ProxyFactoryFn = JsFn<NativeProxySlot, (), true>;

/// Where a proxy function leaves the proxy it made up: as a URL, or as a `ProxyConfig` object
/// (a chain, a custom credential).
#[napi]
#[derive(Clone, Default)]
pub struct NativeProxySlot {
    proxy: Arc<Mutex<Option<ProxyConfig>>>,
}

#[napi]
impl NativeProxySlot {
    /// Answers with the proxy at `url`.
    #[napi]
    pub fn set_url(&self, url: String) -> napi::Result<()> {
        let proxy = ProxyConfig::parse(&url)
            .map_err(|err| invalid_arg(format!("invalid proxy {url:?}: {err}")))?;
        self.put(proxy);
        Ok(())
    }

    /// Answers with a proxy configuration.
    #[napi]
    pub fn set_config(&self, proxy: &NativeProxyConfig) {
        self.put(proxy.inner.clone());
    }
}

impl NativeProxySlot {
    /// Stores the answer.
    fn put(&self, proxy: ProxyConfig) {
        *self.proxy.lock().unwrap_or_else(PoisonError::into_inner) = Some(proxy);
    }

    /// Takes the answer out, if the function left one.
    fn take(&self) -> Option<ProxyConfig> {
        self.proxy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

/// Calls the function through `call` and takes what it left in the slot.
fn answer(
    outcome: Result<(), CallbackError>,
    slot: &NativeProxySlot,
) -> Result<ProxyConfig, CallbackError> {
    outcome?;
    slot.take()
        .ok_or_else(|| CallbackError::Failed("the proxy function returned no proxy".to_owned()))
}

/// Upstream's provider trait backed by a JavaScript function.
pub(crate) struct JsProxyProvider {
    shared: Arc<Shared>,
}

/// What the provider and its refill task share.
struct Shared {
    factory: ProxyFactoryFn,
    timeout: Duration,
    /// Proxies kept ready; 0 for none.
    capacity: usize,
    ready: Mutex<VecDeque<ProxyConfig>>,
    /// Wakes the refill task when a proxy was taken, or when the provider is gone.
    wake: Notify,
    closed: AtomicBool,
}

impl JsProxyProvider {
    /// A provider calling `factory`, keeping `buffer` proxies ready when that is above zero.
    ///
    /// Must run inside the runtime context, which the refill task is spawned on.
    pub(crate) fn new(factory: ProxyFactoryFn, timeout: Duration, buffer: usize) -> Self {
        let shared = Arc::new(Shared {
            factory,
            timeout,
            capacity: buffer,
            ready: Mutex::new(VecDeque::with_capacity(buffer)),
            wake: Notify::new(),
            closed: AtomicBool::new(false),
        });
        if buffer > 0 {
            tokio::spawn(refill(Arc::clone(&shared)));
        }
        Self { shared }
    }
}

impl ProxyProvider for JsProxyProvider {
    /// A ready proxy if there is one, else whatever the function gives now. `None` when the
    /// function fails; upstream's pools then ask again shortly.
    fn next_proxy(&self) -> Option<ProxyConfig> {
        if let Some(proxy) = self.shared.take_ready() {
            return Some(proxy);
        }
        let slot = NativeProxySlot::default();
        let outcome = call_blocking(&self.shared.factory, slot.clone(), self.shared.timeout);
        match answer(outcome, &slot) {
            Ok(proxy) => Some(proxy),
            Err(err) => {
                tracing::warn!(
                    target: "lkrequest_napi::bridge",
                    error = %err,
                    "the proxy function failed"
                );
                None
            }
        }
    }

    /// Every call gives a new proxy: no single list to count.
    fn len(&self) -> usize {
        1
    }

    /// Proxies are made up on demand, so the pool tracks no failures per proxy.
    fn is_dynamic(&self) -> bool {
        true
    }
}

impl Drop for JsProxyProvider {
    /// Lets the refill task finish, which releases the function.
    fn drop(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        self.shared.wake.notify_one();
    }
}

impl Shared {
    /// Takes a ready proxy and asks for a replacement.
    fn take_ready(&self) -> Option<ProxyConfig> {
        let proxy = self
            .ready
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()?;
        self.wake.notify_one();
        Some(proxy)
    }

    /// Whether the buffer wants another proxy.
    fn wants_more(&self) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self
                .ready
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .len()
                < self.capacity
    }
}

/// Keeps the buffer full: asks the function whenever there is room, and sleeps otherwise.
async fn refill(shared: Arc<Shared>) {
    loop {
        while shared.wants_more() {
            let slot = NativeProxySlot::default();
            let outcome = call(&shared.factory, slot.clone(), Some(shared.timeout)).await;
            match answer(outcome, &slot) {
                Ok(proxy) => shared
                    .ready
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push_back(proxy),
                // The environment is going away; nothing will answer again.
                Err(CallbackError::Closing) => return,
                Err(err) => {
                    tracing::warn!(
                        target: "lkrequest_napi::bridge",
                        error = %err,
                        "the proxy function failed while filling the buffer"
                    );
                    tokio::time::sleep(REFILL_RETRY_DELAY).await;
                }
            }
        }
        if shared.closed.load(Ordering::Acquire) {
            return;
        }
        // A permit stored by a pop that happened mid-call makes this return at once.
        shared.wake.notified().await;
    }
}
