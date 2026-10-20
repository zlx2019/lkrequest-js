//! Request body streams pulled from JavaScript.
//!
//! Upstream's `RequestBuilder::body_stream` consumes a `Stream<Item = io::Result<Bytes>>` and
//! polls it only as the transport makes progress. [`PullStream`] answers each poll by asking
//! JavaScript for one chunk, so a JavaScript source (`ReadableStream`, `Readable`, an async
//! iterable, adapted by the TypeScript facade) feels the connection's backpressure. Nothing is
//! read ahead: at most one pull is in flight. This mirrors `AsyncSource` in lkrequest-py.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures_core::Stream;

use super::buffer::JsBytes;
use super::callback::{self, CallbackError, JsFn};

/// The JavaScript pull function: resolves with the next chunk, or `null` at the end.
pub(crate) type PullFn = JsFn<(), Option<JsBytes>, false>;

/// A pull that has been sent to JavaScript and is waiting for its chunk.
type PendingPull = Pin<Box<dyn Future<Output = Result<Option<JsBytes>, CallbackError>> + Send>>;

/// An upload body that asks JavaScript for the next chunk only when upstream polls for it.
pub(crate) struct PullStream {
    pull: Arc<PullFn>,
    pending: Option<PendingPull>,
    done: bool,
}

impl PullStream {
    /// Wraps a JavaScript pull function. Nothing is pulled until the stream is first polled.
    pub(crate) fn new(pull: PullFn) -> Self {
        Self {
            pull: Arc::new(pull),
            pending: None,
            done: false,
        }
    }
}

/// Starts the next pull. No timeout: a slow producer is legitimate, and upstream's request
/// timeouts bound how long the transport waits for it.
fn start_pull(pull: &Arc<PullFn>) -> PendingPull {
    let pull = Arc::clone(pull);
    Box::pin(async move { callback::call(&pull, (), None).await })
}

impl Stream for PullStream {
    type Item = io::Result<Bytes>;

    /// Resolves with the chunk of the pull in flight, starting one if none is.
    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }
        let pending = this.pending.get_or_insert_with(|| start_pull(&this.pull));
        let Poll::Ready(result) = pending.as_mut().poll(context) else {
            return Poll::Pending;
        };
        this.pending = None;
        match result {
            Ok(Some(JsBytes(chunk))) => Poll::Ready(Some(Ok(chunk))),
            Ok(None) => {
                this.done = true;
                Poll::Ready(None)
            }
            Err(err) => {
                this.done = true;
                Poll::Ready(Some(Err(io::Error::other(format!(
                    "request body stream failed: {err}"
                )))))
            }
        }
    }
}
