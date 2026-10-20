//! Plumbing between the Tokio runtime and the JavaScript thread: callbacks, buffers, streams,
//! cancellation and in-flight tracking.

pub(crate) mod buffer;
pub(crate) mod callback;
pub(crate) mod cancel;
pub(crate) mod inflight;
pub(crate) mod stream;
