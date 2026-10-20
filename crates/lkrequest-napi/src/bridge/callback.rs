//! JavaScript callbacks invoked from Tokio worker threads.
//!
//! Upstream runs user hooks on runtime workers, but a JavaScript function can only run on the
//! thread that owns its environment. Every hook therefore reaches JavaScript through a
//! threadsafe function, and the caller waits for the result in one of two ways:
//!
//! - [`call`] awaits it, for upstream's async traits and for flows the binding drives itself;
//! - [`call_blocking`] blocks for it, for upstream's synchronous traits (`RetryPolicy`,
//!   `HstsPolicy`, `ProxyProvider`, ...).
//!
//! The TypeScript facade wraps every user function so that it always returns a Promise, which
//! is why [`JsFn`] has a single return shape.

use std::fmt;
use std::time::Duration;

use napi::Status;
use napi::bindgen_prelude::{FromNapiValue, JsValuesTupleIntoVec, Promise};
use napi::threadsafe_function::ThreadsafeFunction;

/// A JavaScript function taking `Args` and returning `Promise<Ret>`, callable from any thread.
///
/// A `WEAK` function does not keep the Node.js event loop alive. Use it for hooks that live as
/// long as a client or session, so an idle client never blocks process exit.
pub(crate) type JsFn<Args, Ret, const WEAK: bool> =
    ThreadsafeFunction<Args, Promise<Ret>, Args, Status, false, WEAK>;

/// Why a JavaScript callback produced no value.
#[derive(Debug)]
pub(crate) enum CallbackError {
    /// [`call_blocking`] ran outside a Tokio task, most likely on the JavaScript thread itself,
    /// where waiting for a callback would deadlock.
    NotOnRuntime,
    /// The callback did not settle within the allowed time.
    TimedOut(Duration),
    /// The callback's JavaScript environment is shutting down and no longer runs callbacks.
    Closing,
    /// The callback threw or its Promise rejected; carries the JavaScript error message.
    Failed(String),
}

impl fmt::Display for CallbackError {
    /// Formats the error as a sentence suitable for an error message.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotOnRuntime => f.write_str(
                "a synchronous JavaScript callback was invoked outside the Tokio runtime \
                 (waiting for it on the JavaScript thread would deadlock)",
            ),
            Self::TimedOut(timeout) => write!(
                f,
                "the JavaScript callback did not settle within {} ms",
                timeout.as_millis()
            ),
            Self::Closing => f.write_str("the JavaScript environment is shutting down"),
            Self::Failed(reason) => write!(f, "the JavaScript callback failed: {reason}"),
        }
    }
}

impl std::error::Error for CallbackError {}

impl From<napi::Error> for CallbackError {
    /// Classifies a failure reported by napi-rs while calling or awaiting a callback.
    fn from(err: napi::Error) -> Self {
        if err.status == Status::Closing {
            Self::Closing
        } else {
            Self::Failed(err.reason)
        }
    }
}

impl From<CallbackError> for napi::Error {
    /// Turns the error into a generic JavaScript `Error` carrying the same message.
    fn from(err: CallbackError) -> Self {
        napi::Error::from_reason(err.to_string())
    }
}

/// Calls `callback` and waits for its Promise without blocking the current thread.
///
/// `timeout` bounds the whole round trip. Pass `None` only when something else bounds the wait
/// (a request deadline or cancellation): if the callback's environment is torn down while the
/// call is queued, napi-rs drops the call without ever answering it.
pub(crate) async fn call<Args, Ret, const WEAK: bool>(
    callback: &JsFn<Args, Ret, WEAK>,
    args: Args,
    timeout: Option<Duration>,
) -> Result<Ret, CallbackError>
where
    Args: 'static + Send + JsValuesTupleIntoVec,
    Ret: 'static + Send + FromNapiValue,
{
    // `call_async_catch` reports a synchronous throw as `Err`; plain `call_async` would route
    // it to `napi_fatal_exception` and terminate the process.
    let round_trip = async {
        let promise = callback.call_async_catch(args).await?;
        Ok(promise.await?)
    };
    match timeout {
        Some(limit) => tokio::time::timeout(limit, round_trip)
            .await
            .map_err(|_| CallbackError::TimedOut(limit))?,
        None => round_trip.await,
    }
}

/// Calls `callback` from synchronous code running on a Tokio worker and blocks until its
/// Promise settles or `timeout` elapses.
///
/// Upstream invokes its synchronous traits from inside request futures. While this thread
/// waits, `block_in_place` hands the worker's other tasks to a replacement thread, so the rest
/// of the runtime keeps making progress.
///
/// Refuses to run outside a Tokio task: the only other thread that reaches upstream code is the
/// JavaScript thread, and blocking it on one of its own callbacks would never return.
pub(crate) fn call_blocking<Args, Ret, const WEAK: bool>(
    callback: &JsFn<Args, Ret, WEAK>,
    args: Args,
    timeout: Duration,
) -> Result<Ret, CallbackError>
where
    Args: 'static + Send + JsValuesTupleIntoVec,
    Ret: 'static + Send + FromNapiValue,
{
    // The JavaScript thread may have entered the runtime context (`Handle::try_current`
    // succeeds there), but it never runs a Tokio task, so the task id is the reliable signal.
    if tokio::task::try_id().is_none() {
        return Err(CallbackError::NotOnRuntime);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(call(callback, args, Some(timeout)))
    })
}
