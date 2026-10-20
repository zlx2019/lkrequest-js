//! TLS key logging to a JavaScript function.
//!
//! Upstream calls its `KeyLogCallback` synchronously from the handshake, which runs on a Tokio
//! worker. The function only observes, so each line is queued for the JavaScript thread without
//! waiting for it.

use std::sync::Arc;

use lkrequest::KeyLogCallback;
use napi::Status;
use napi::threadsafe_function::{
    ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};

/// A JavaScript function called with each key-log line. The facade wraps the user's function
/// so that it never throws, which would otherwise terminate the process. Weak, so it never
/// keeps the process alive.
pub(crate) type KeylogFn =
    ThreadsafeFunction<String, UnknownReturnValue, String, Status, false, true>;

/// Upstream's key-log callback delivering every line to `sink`.
pub(crate) fn callback(sink: KeylogFn) -> KeyLogCallback {
    Arc::new(move |line: &str| {
        // A closing environment drops the line; a handshake must never wait for JavaScript.
        let _ = sink.call(line.to_owned(), ThreadsafeFunctionCallMode::NonBlocking);
    })
}
