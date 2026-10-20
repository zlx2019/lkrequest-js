//! Retry policies: upstream's exponential backoff and fixed interval, or a JavaScript function.
//!
//! Upstream asks its `RetryPolicy` synchronously from inside the request future, so a
//! JavaScript policy goes through the blocking callback bridge. It is asked only after a
//! failure or a retryable status, which keeps the round trips rare.

use std::fmt;
use std::time::Duration;

use lkrequest::retry::RetryPolicy;
use lkrequest::session::SessionBuilder;
use lkrequest::{ExponentialBackoff, FixedInterval};
use napi::bindgen_prelude::FnArgs;
use napi_derive::napi;

use crate::bridge::callback::{JsFn, call_blocking};
use crate::error::{NativeError, invalid_arg};
use crate::types::duration_from_ms;

/// How long a JavaScript retry policy may take to answer before the request gives up retrying.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(30);

/// A JavaScript retry policy: `(attempt, error, status)` resolving with a delay in
/// milliseconds, or `null` to stop. `FnArgs` spreads the tuple into three arguments (a bare
/// tuple would arrive as one array). Weak, so a session's policy never keeps the process
/// alive.
pub(crate) type RetryFn = JsFn<FnArgs<(u32, Option<NativeError>, Option<u16>)>, Option<f64>, true>;

/// A built-in retry strategy with its parameters; durations in milliseconds.
#[napi(object, object_to_js = false)]
pub struct NativeRetryStrategy {
    /// `exponential` or `fixed`.
    pub strategy: String,
    /// Retries before giving up (default 3).
    pub max_retries: Option<u32>,
    /// First delay of the exponential strategy (default 1000).
    pub base_delay: Option<f64>,
    /// Largest delay of the exponential strategy (default 30000).
    pub max_delay: Option<f64>,
    /// Randomize the exponential delays (default `true`).
    pub jitter: Option<bool>,
    /// Delay of the fixed strategy (default 1000).
    pub interval: Option<f64>,
}

/// Installs the strategy, or the JavaScript policy, on a session.
pub(crate) fn configure(
    builder: SessionBuilder,
    strategy: Option<&NativeRetryStrategy>,
    callback: Option<RetryFn>,
) -> napi::Result<SessionBuilder> {
    match (strategy, callback) {
        (Some(_), Some(_)) => Err(invalid_arg(
            "retry must be either a strategy object or a function",
        )),
        (Some(strategy), None) => builtin(builder, strategy),
        (None, Some(callback)) => Ok(builder.retry_policy(JsRetryPolicy { callback })),
        (None, None) => Ok(builder),
    }
}

/// Installs one of upstream's strategies, with lkrequest-py's defaults.
fn builtin(
    builder: SessionBuilder,
    strategy: &NativeRetryStrategy,
) -> napi::Result<SessionBuilder> {
    let max_retries = strategy.max_retries.unwrap_or(3);
    let ms = |value: Option<f64>, default: f64, name: &str| {
        duration_from_ms(value.unwrap_or(default), name)
    };
    match strategy.strategy.as_str() {
        "exponential" => {
            let policy = ExponentialBackoff::new(
                max_retries,
                ms(strategy.base_delay, 1_000.0, "retry.baseDelay")?,
                ms(strategy.max_delay, 30_000.0, "retry.maxDelay")?,
            )
            .with_jitter(strategy.jitter.unwrap_or(true));
            Ok(builder.retry_policy(policy))
        }
        "fixed" => {
            let interval = ms(strategy.interval, 1_000.0, "retry.interval")?;
            Ok(builder.retry_policy(FixedInterval::new(max_retries, interval)))
        }
        other => Err(invalid_arg(format!(
            "unknown retry strategy {other:?}; expected exponential or fixed"
        ))),
    }
}

/// Upstream's retry trait backed by a JavaScript function.
struct JsRetryPolicy {
    callback: RetryFn,
}

impl fmt::Debug for JsRetryPolicy {
    /// Identifies the policy without exposing the function.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JsRetryPolicy")
    }
}

impl RetryPolicy for JsRetryPolicy {
    /// Asks the JavaScript function; anything but a valid delay means "do not retry".
    fn should_retry(
        &self,
        attempt: u32,
        error: Option<&lkrequest::error::Error>,
        status: Option<http::StatusCode>,
    ) -> Option<Duration> {
        let args = FnArgs::from((
            attempt,
            error.map(NativeError::from_upstream),
            status.map(|status| status.as_u16()),
        ));
        match call_blocking(&self.callback, args, CALLBACK_TIMEOUT) {
            Ok(Some(ms)) => match Duration::try_from_secs_f64(ms / 1000.0) {
                Ok(delay) => Some(delay),
                Err(_) => {
                    tracing::warn!(
                        target: "lkrequest_napi::bridge",
                        delay = ms,
                        "retry function returned an invalid delay; not retrying"
                    );
                    None
                }
            },
            Ok(None) => None,
            Err(err) => {
                tracing::warn!(
                    target: "lkrequest_napi::bridge",
                    error = %err,
                    "retry function failed; not retrying"
                );
                None
            }
        }
    }
}
