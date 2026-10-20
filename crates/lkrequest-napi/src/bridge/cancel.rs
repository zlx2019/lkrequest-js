//! Cancellation of native work, triggered from JavaScript.
//!
//! The TypeScript facade adapts an `AbortSignal` into an [`AbortHandle`]: aborting the signal
//! calls `abort()`, and the request future racing the token is dropped, which releases its
//! connection and streams.

use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::Poll;

use napi_derive::napi;
use tokio::sync::Notify;

/// A one-shot cancellation flag that async work can wait on.
#[derive(Default)]
pub(crate) struct CancelToken {
    cancelled: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    /// Marks the token cancelled and wakes everything waiting on it.
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    /// Resolves once the token is cancelled, immediately if it already is.
    pub(crate) async fn cancelled(&self) {
        loop {
            // Register before checking the flag so a concurrent `cancel` cannot be missed.
            let notified = self.notify.notified();
            if self.cancelled.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

/// Runs `work` until it finishes or `token` is cancelled; `None` means it was cancelled and
/// `work` has been dropped.
pub(crate) async fn until_cancelled<F: Future>(
    token: Option<&CancelToken>,
    work: F,
) -> Option<F::Output> {
    let Some(token) = token else {
        return Some(work.await);
    };
    let mut work = pin!(work);
    let mut cancelled = pin!(token.cancelled());
    std::future::poll_fn(|context| {
        // Checked first so a request aborted before it started never reaches the network.
        if cancelled.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }
        work.as_mut().poll(context).map(Some)
    })
    .await
}

/// Native side of an `AbortSignal`: aborting it cancels the request it was passed to.
#[napi]
pub struct AbortHandle {
    token: Arc<CancelToken>,
}

#[napi]
impl AbortHandle {
    /// Creates a handle that has not been aborted.
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self {
            token: Arc::default(),
        }
    }

    /// Cancels the work this handle was passed to. Calling it again has no effect.
    #[napi]
    pub fn abort(&self) {
        self.token.cancel();
    }
}

impl AbortHandle {
    /// The token shared with the work this handle controls.
    pub(crate) fn token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.token)
    }
}
