//! Streaming responses: the body is read chunk by chunk as the facade pulls it.
//!
//! Upstream's `send_streaming` returns the first response as is: it follows no redirect and
//! applies no retry policy. Each `read()` is a separate operation, so an open stream that
//! nobody reads holds no in-flight count.

use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use lkrequest::StreamingResponse;
use lkrequest::session::RequestBuilder;
use napi::Env;
use napi::bindgen_prelude::{AsyncBlock, AsyncBlockBuilder};
use napi_derive::napi;
use tokio::sync::Mutex;

use crate::bridge::buffer::ExternalBytes;
use crate::bridge::cancel::{AbortHandle, CancelToken, until_cancelled};
use crate::bridge::inflight::{Delivered, InFlightGuard};
use crate::error::NativeError;
use crate::response::flat_headers;

/// The result of starting a streaming request, as the facade receives it.
#[napi(object, object_from_js = false)]
pub struct NativeStreamOutcome {
    /// Set when the server answered.
    pub response: Option<NativeStreamingResponse>,
    /// Set when the request failed.
    pub error: Option<NativeError>,
}

/// One read from a streaming body: data, the end (neither field set), or an error.
#[napi(object, object_from_js = false)]
pub struct NativeChunk {
    /// The next decoded chunk, handed over without a copy where possible.
    #[napi(ts_type = "Buffer")]
    pub data: Option<ExternalBytes>,
    /// Why the body could not be read.
    pub error: Option<NativeError>,
}

impl NativeChunk {
    /// The end of the body.
    fn end() -> Self {
        Self {
            data: None,
            error: None,
        }
    }

    /// A chunk of body data.
    fn data(bytes: Bytes) -> Self {
        Self {
            data: Some(ExternalBytes(bytes)),
            error: None,
        }
    }

    /// A failed read.
    fn failed(error: NativeError) -> Self {
        Self {
            data: None,
            error: Some(error),
        }
    }
}

/// A response whose body has not been read yet.
#[napi]
pub struct NativeStreamingResponse {
    status: u16,
    headers: Vec<String>,
    body: Arc<Mutex<Option<StreamingResponse>>>,
    cancelled: Arc<CancelToken>,
}

#[napi]
impl NativeStreamingResponse {
    /// HTTP status code.
    #[napi(getter)]
    pub fn status(&self) -> u16 {
        self.status
    }

    /// Canonical reason phrase of the status.
    #[napi(getter)]
    pub fn status_text(&self) -> String {
        http::StatusCode::from_u16(self.status)
            .ok()
            .and_then(|status| status.canonical_reason())
            .unwrap_or_default()
            .to_owned()
    }

    /// Headers as flat name/value pairs: lower-case names, duplicates kept, upstream order.
    #[napi(getter)]
    pub fn headers(&self) -> Vec<String> {
        self.headers.clone()
    }

    /// Reads the next decoded chunk. Resolves with data, the end, or an error, and never
    /// rejects. After the end, an error, an abort or `cancel()`, every read reports the end.
    #[napi(ts_return_type = "Promise<NativeChunk>")]
    pub fn read(
        &self,
        env: Env,
        abort: Option<&AbortHandle>,
    ) -> napi::Result<AsyncBlock<Delivered<NativeChunk>>> {
        let guard = InFlightGuard::register();
        let body = Arc::clone(&self.body);
        let cancelled = Arc::clone(&self.cancelled);
        let abort = abort.map(AbortHandle::token);
        let work = async move {
            let chunk = read_chunk(&body, &cancelled, abort.as_deref()).await;
            Ok(Delivered::new(chunk, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }

    /// Releases the body without reading the rest; a pending read ends at once.
    #[napi]
    pub fn cancel(&self) {
        self.cancelled.cancel();
        // A pending read holds the lock and drops the body itself once it sees the token.
        if let Ok(mut body) = self.body.try_lock() {
            body.take();
        }
    }
}

impl NativeStreamingResponse {
    /// Wraps an upstream streaming response.
    fn new(response: StreamingResponse) -> Self {
        Self {
            status: response.status().as_u16(),
            headers: flat_headers(response.headers()),
            body: Arc::new(Mutex::new(Some(response))),
            cancelled: Arc::new(CancelToken::default()),
        }
    }
}

/// Reads the next non-empty chunk, dropping the body once it ends, fails or is cancelled.
async fn read_chunk(
    body: &Mutex<Option<StreamingResponse>>,
    cancelled: &CancelToken,
    abort: Option<&CancelToken>,
) -> NativeChunk {
    let mut slot = body.lock().await;
    let Some(stream) = slot.as_mut() else {
        return NativeChunk::end();
    };
    let next = until_cancelled(Some(cancelled), next_chunk(stream));
    let chunk = match until_cancelled(abort, next).await {
        Some(Some(Ok(Some(bytes)))) => return NativeChunk::data(bytes),
        Some(Some(Ok(None))) | Some(None) => NativeChunk::end(),
        Some(Some(Err(err))) => {
            tracing::error!(error = %err, "response body failed");
            NativeChunk::failed(NativeError::from_upstream(&err))
        }
        None => NativeChunk::failed(NativeError::aborted()),
    };
    slot.take();
    chunk
}

/// The next decoded chunk, skipping empty ones.
async fn next_chunk(stream: &mut StreamingResponse) -> lkrequest::error::Result<Option<Bytes>> {
    loop {
        match stream.chunk_decoded().await? {
            Some(bytes) if bytes.is_empty() => continue,
            other => return Ok(other),
        }
    }
}

/// Sends a streaming request and describes how it started. Never fails: errors become
/// outcomes.
pub(crate) async fn send(
    builder: RequestBuilder,
    cancel: Option<&CancelToken>,
    method: &str,
    url: &str,
) -> NativeStreamOutcome {
    tracing::debug!(method, url, "sending streaming request");
    let started = Instant::now();
    let Some(result) = until_cancelled(cancel, builder.send_streaming()).await else {
        tracing::debug!(method, url, "request aborted");
        return NativeStreamOutcome {
            response: None,
            error: Some(NativeError::aborted()),
        };
    };
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(response) => {
            tracing::debug!(
                method,
                url,
                status = response.status().as_u16(),
                elapsed_ms,
                "response headers received"
            );
            NativeStreamOutcome {
                response: Some(NativeStreamingResponse::new(response)),
                error: None,
            }
        }
        Err(err) => {
            tracing::error!(method, url, elapsed_ms, error = %err, "request failed");
            NativeStreamOutcome {
                response: None,
                error: Some(NativeError::from_upstream(&err)),
            }
        }
    }
}
