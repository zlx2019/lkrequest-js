//! Requests whose results JavaScript has not received yet.
//!
//! Mirrors the in-flight tracking of lkrequest-py (`src/bridge.rs`). When a request stops
//! counting decides what `drainPending()` resolving `true` guarantees:
//!
//! - it counts from submission, before anything fallible runs, so a request rejected while it
//!   is being prepared rolls the count back when its guard drops;
//! - a request dropped before it completes (its worker's environment shut down, the runtime
//!   stopped) releases its slot at once: there is nothing left to deliver;
//! - a completed request hands its guard to the result ([`Delivered`]), which releases it on
//!   the JavaScript thread right after converting the value, just before the Promise settles.
//!   An environment that is gone drops the undelivered result, and the guard with it.
//!
//! The `drainPending()` Promise settles through the same queue later, so by the time
//! JavaScript observes `true`, every counted request has already settled.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use napi::bindgen_prelude::ToNapiValue;
use napi::sys;
use napi_derive::napi;
use tokio::sync::Notify;

/// Requests submitted but not yet delivered, process-wide (shared by every environment).
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Woken whenever [`IN_FLIGHT`] drops to zero.
static IDLE: Notify = Notify::const_new();

/// Holds one unit of the in-flight count and releases it when dropped.
pub(crate) struct InFlightGuard {
    _private: (),
}

impl InFlightGuard {
    /// Counts a request that is being submitted.
    pub(crate) fn register() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
        Self { _private: () }
    }
}

impl Drop for InFlightGuard {
    /// Releases the slot and wakes drain waiters when nothing is left in flight.
    fn drop(&mut self) {
        if IN_FLIGHT.fetch_sub(1, Ordering::AcqRel) == 1 {
            IDLE.notify_waiters();
        }
    }
}

/// A request result that releases its in-flight slot once JavaScript has received it.
pub struct Delivered<T> {
    value: T,
    guard: InFlightGuard,
}

impl<T> Delivered<T> {
    /// Pairs a finished result with the guard taken when the request was submitted.
    pub(crate) fn new(value: T, guard: InFlightGuard) -> Self {
        Self { value, guard }
    }
}

impl<T: ToNapiValue> ToNapiValue for Delivered<T> {
    /// Converts the value on the JavaScript thread, then releases the slot.
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        let Self { value, guard } = val;
        let converted = unsafe { T::to_napi_value(env, value) };
        drop(guard);
        converted
    }
}

/// Number of requests that have been submitted but whose results JavaScript has not received.
#[napi]
pub fn pending_requests() -> u32 {
    u32::try_from(IN_FLIGHT.load(Ordering::Acquire)).unwrap_or(u32::MAX)
}

/// Resolves once no request is in flight, or after `timeoutMs`. Resolves `true` when the count
/// reached zero, which guarantees every counted request has already settled.
#[napi]
pub async fn drain_pending(timeout_ms: Option<f64>) -> bool {
    let idle = async {
        loop {
            // Register before re-reading: a request finishing in between would otherwise
            // notify while nobody is listening.
            let notified = IDLE.notified();
            if IN_FLIGHT.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    };
    match timeout_ms.and_then(|ms| Duration::try_from_secs_f64(ms / 1000.0).ok()) {
        Some(limit) => tokio::time::timeout(limit, idle).await.is_ok(),
        None => {
            idle.await;
            true
        }
    }
}
