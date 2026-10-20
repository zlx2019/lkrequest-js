//! Byte buffers crossing between Rust and JavaScript.

use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use napi::bindgen_prelude::{BufferSlice, FromNapiValue, ToNapiValue, Uint8ArraySlice};
use napi::{Env, sys};

/// External buffers handed to JavaScript whose finalizer has not run yet.
static LIVE_EXTERNAL_BUFFERS: AtomicUsize = AtomicUsize::new(0);

/// Bytes that become a Node.js `Buffer`, without a copy whenever that is safe.
///
/// On the zero-copy path the `Buffer` points straight into the allocation, and its finalizer
/// owns the memory until V8 collects the `Buffer`. V8 counts external backing stores towards
/// its GC heuristics, so large bodies still create GC pressure.
///
/// The bytes are copied instead when
/// - the allocation is shared with another `Bytes` handle, or is static. V8 aborts the process
///   if two external buffers cover the same memory, and the other handle could be exported
///   again;
/// - the buffer is empty (V8 rejects external buffers without data);
/// - the runtime forbids external buffers (Electron); napi-rs falls back to a copy there.
pub struct ExternalBytes(pub(crate) Bytes);

impl ToNapiValue for ExternalBytes {
    /// Creates the `Buffer` on the JavaScript thread.
    unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> napi::Result<sys::napi_value> {
        let env = Env::from_raw(env);
        let buffer = match val.0.try_into_mut() {
            Ok(mut owned) if !owned.is_empty() => {
                let data = owned.as_mut_ptr();
                let len = owned.len();
                LIVE_EXTERNAL_BUFFERS.fetch_add(1, Ordering::Relaxed);
                // SAFETY: `data` and `len` describe the allocation of `owned`, which is the only
                // handle to it and moves into the finalizer, so the memory stays valid and
                // unaliased until V8 releases the `Buffer`. If napi-rs takes its copy fallback
                // it runs the finalizer right away, which keeps the counter balanced.
                unsafe {
                    BufferSlice::from_external(&env, data, len, owned, |_, owned| {
                        drop(owned);
                        LIVE_EXTERNAL_BUFFERS.fetch_sub(1, Ordering::Relaxed);
                    })
                }
            }
            Ok(owned) => BufferSlice::copy_from(&env, owned),
            Err(shared) => BufferSlice::copy_from(&env, shared),
        }?;
        unsafe { ToNapiValue::to_napi_value(env.raw(), &buffer) }
    }
}

/// Number of zero-copy buffers that JavaScript still holds.
///
/// Lets tests observe that finalizers run, and that each finalizer runs exactly once.
pub(crate) fn live_external_buffers() -> usize {
    LIVE_EXTERNAL_BUFFERS.load(Ordering::Relaxed)
}

/// Bytes copied out of a JavaScript `Uint8Array` (including a Node.js `Buffer`).
///
/// The copy happens on the JavaScript thread during argument conversion. Keeping a reference
/// to the JavaScript memory instead would be unsound: JavaScript may mutate, detach or transfer
/// the underlying `ArrayBuffer` while a Tokio worker is still reading it.
pub struct JsBytes(pub(crate) Bytes);

impl FromNapiValue for JsBytes {
    /// Copies the viewed bytes; rejects anything that is not a `Uint8Array`.
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        let view = unsafe { Uint8ArraySlice::from_napi_value(env, value)? };
        Ok(Self(Bytes::copy_from_slice(&view)))
    }
}
