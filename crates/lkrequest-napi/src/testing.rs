//! Test hooks for the parts of the native layer no public API can reach on purpose.
//!
//! Exported under `native.testing` and never re-exported by the facade. The synchronous
//! callback bridge's JavaScript-thread guard, for one, exists precisely so that no public path
//! hits it, and nothing public panics on purpose.

use std::sync::LazyLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use bytes::Bytes;
use napi_derive::napi;

use crate::bridge::buffer::{self, ExternalBytes};
use crate::bridge::callback::{self, JsFn};

/// `testing.syncCall` invocations currently blocked waiting for JavaScript.
static BLOCKED_CALLS: AtomicU32 = AtomicU32::new(0);

/// Bytes shared by every `testing.sharedBuffer` call, so each export sees a shared allocation.
static SHARED_BYTES: LazyLock<Bytes> = LazyLock::new(|| Bytes::from(vec![0x5a; 4096]));

/// Counts one call in [`BLOCKED_CALLS`] for as long as it is alive.
struct BlockedCall;

impl BlockedCall {
    /// Registers a call that is about to block.
    fn enter() -> Self {
        BLOCKED_CALLS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for BlockedCall {
    /// Unregisters the call, however it ended.
    fn drop(&mut self) {
        BLOCKED_CALLS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Calls `callback(value)` through the synchronous bridge from inside a runtime task, the way
/// upstream invokes a synchronous trait such as `RetryPolicy`, and resolves with its result.
#[napi(namespace = "testing")]
pub async fn sync_call(
    #[napi(ts_arg_type = "(value: number) => Promise<number>")] callback: JsFn<u32, u32, true>,
    value: u32,
    timeout_ms: u32,
) -> napi::Result<u32> {
    let _blocked = BlockedCall::enter();
    let timeout = Duration::from_millis(timeout_ms.into());
    Ok(callback::call_blocking(&callback, value, timeout)?)
}

/// Calls the synchronous bridge on the JavaScript thread itself, which must fail at once
/// instead of deadlocking.
#[napi(namespace = "testing")]
pub fn sync_call_on_js_thread(
    #[napi(ts_arg_type = "(value: number) => Promise<number>")] callback: JsFn<u32, u32, true>,
    value: u32,
) -> napi::Result<u32> {
    Ok(callback::call_blocking(
        &callback,
        value,
        Duration::from_secs(5),
    )?)
}

/// Number of `testing.syncCall` invocations still blocked waiting for JavaScript.
#[napi(namespace = "testing")]
pub fn blocked_calls() -> u32 {
    BLOCKED_CALLS.load(Ordering::SeqCst)
}

/// Resolves after `ms` milliseconds on the runtime, to measure scheduling latency.
#[napi(namespace = "testing")]
pub async fn sleep(ms: u32) {
    tokio::time::sleep(Duration::from_millis(ms.into())).await;
}

/// Resolves with a `size`-byte Buffer filled with `fill`, handed over without a copy.
#[napi(namespace = "testing", ts_return_type = "Promise<Buffer>")]
pub async fn external_buffer(size: u32, fill: u8) -> ExternalBytes {
    ExternalBytes(Bytes::from(vec![fill; size as usize]))
}

/// Resolves with a Buffer over bytes that another handle still shares, which must take the
/// copy path.
#[napi(namespace = "testing", ts_return_type = "Promise<Buffer>")]
pub async fn shared_buffer() -> ExternalBytes {
    ExternalBytes(SHARED_BYTES.clone())
}

/// Number of zero-copy buffers that JavaScript still holds.
#[napi(namespace = "testing")]
pub fn live_external_buffers() -> u32 {
    u32::try_from(buffer::live_external_buffers()).unwrap_or(u32::MAX)
}

/// Panics synchronously, behind `catch_unwind` like the native entry points that call upstream
/// code: the panic must surface as a thrown error rather than abort the process.
#[napi(namespace = "testing", catch_unwind)]
pub fn panic_sync(message: String) {
    panic!("{message}");
}

/// Panics inside a future: napi-rs rejects its promise instead of aborting.
#[napi(namespace = "testing")]
pub async fn panic_async(message: String) {
    panic!("{message}");
}
