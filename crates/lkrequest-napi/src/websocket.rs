//! WebSocket connections opened through a session, which keep its fingerprint, cookies, proxy
//! and timeouts.
//!
//! Upstream's `WsConnection` takes `&self` and keeps its reader and writer apart, so a receive
//! waiting for a message holds up neither a send nor a close. Two tasks share the connection:
//! one runs the receives in call order, the other the sends and the close, in call order. A
//! receive always runs to its end, since upstream's frame parser cannot be cancelled safely
//! once part of a frame has arrived. Once a close frame is sent, or a close message or an
//! error is received, both tasks stop as soon as they are idle, which releases the connection.
//! The tasks keep the connection type generic, so the binding needs no direct hyper
//! dependency.

use std::sync::Arc;

use bytes::Bytes;
use lkrequest::Session;
use lkrequest::ws::{WsConnection, WsMessage};
use napi::Env;
use napi::bindgen_prelude::{AsyncBlock, AsyncBlockBuilder};
use napi_derive::napi;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot};

use crate::bridge::buffer::{ExternalBytes, JsBytes};
use crate::bridge::cancel::{AbortHandle, CancelToken, until_cancelled};
use crate::bridge::inflight::{Delivered, InFlightGuard};
use crate::error::NativeError;
use crate::types::pairs;

/// Options of a WebSocket handshake; headers are flat name/value pairs.
#[napi(object, object_to_js = false)]
pub struct NativeWebSocketOptions {
    /// Extra handshake headers as flat name/value pairs.
    pub headers: Option<Vec<String>>,
    /// Subprotocols to offer in `Sec-WebSocket-Protocol`.
    pub protocols: Option<Vec<String>>,
    /// Extensions to offer in `Sec-WebSocket-Extensions`.
    pub extensions: Option<Vec<String>>,
}

/// The result of a handshake, as the facade receives it.
#[napi(object, object_from_js = false)]
pub struct NativeWebSocketOutcome {
    /// Set when the connection is open.
    pub socket: Option<NativeWebSocket>,
    /// Set when the handshake failed.
    pub error: Option<NativeError>,
}

/// One received message, or the error that prevented receiving one.
#[napi(object, object_from_js = false)]
pub struct NativeWebSocketReceive {
    /// `text`, `binary`, `ping`, `pong` or `close`; absent on error.
    pub kind: Option<String>,
    /// Payload of a text message.
    pub text: Option<String>,
    /// Payload of a binary, ping or pong message.
    #[napi(ts_type = "Buffer")]
    pub data: Option<ExternalBytes>,
    /// Status code of a close message, when it carried one.
    pub code: Option<u16>,
    /// Reason of a close message.
    pub reason: Option<String>,
    /// Why no message could be received.
    pub error: Option<NativeError>,
}

impl NativeWebSocketReceive {
    /// A received message.
    fn message(message: WsMessage) -> Self {
        let (kind, text, data, code, reason) = match message {
            WsMessage::Text(text) => ("text", Some(text), None, None, None),
            WsMessage::Binary(data) => ("binary", None, Some(data), None, None),
            WsMessage::Ping(data) => ("ping", None, Some(data), None, None),
            WsMessage::Pong(data) => ("pong", None, Some(data), None, None),
            WsMessage::Close(code, reason) => ("close", None, None, code, Some(reason)),
        };
        Self {
            kind: Some(kind.to_owned()),
            text,
            data: data.map(|data| ExternalBytes(Bytes::from(data))),
            code,
            reason,
            error: None,
        }
    }

    /// A failed receive.
    fn failed(error: NativeError) -> Self {
        Self {
            kind: None,
            text: None,
            data: None,
            code: None,
            reason: None,
            error: Some(error),
        }
    }
}

/// Work for the writer task, each with the channel its result goes back on.
enum Write {
    Send(WsMessage, oneshot::Sender<lkrequest::error::Result<()>>),
    Close(
        Option<(u16, String)>,
        oneshot::Sender<lkrequest::error::Result<()>>,
    ),
}

/// A receive for the reader task: the channel the message goes back on.
type Receive = oneshot::Sender<lkrequest::error::Result<WsMessage>>;

/// An open WebSocket connection.
#[napi]
pub struct NativeWebSocket {
    url: String,
    writes: mpsc::UnboundedSender<Write>,
    receives: mpsc::UnboundedSender<Receive>,
}

#[napi]
impl NativeWebSocket {
    /// URL the connection was opened to.
    #[napi(getter)]
    pub fn url(&self) -> String {
        self.url.clone()
    }

    /// Sends a text message. Resolves with `null`, or with the error that prevented it.
    #[napi(ts_return_type = "Promise<NativeError | null>")]
    pub fn send_text(
        &self,
        env: Env,
        text: String,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        self.send(env, WsMessage::Text(text))
    }

    /// Sends a binary message.
    #[napi(ts_return_type = "Promise<NativeError | null>")]
    pub fn send_binary(
        &self,
        env: Env,
        #[napi(ts_arg_type = "Uint8Array")] data: JsBytes,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        self.send(env, WsMessage::Binary(data.0.to_vec()))
    }

    /// Sends a ping frame.
    #[napi(ts_return_type = "Promise<NativeError | null>")]
    pub fn ping(
        &self,
        env: Env,
        #[napi(ts_arg_type = "Uint8Array")] data: JsBytes,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        self.send(env, WsMessage::Ping(data.0.to_vec()))
    }

    /// Sends a pong frame.
    #[napi(ts_return_type = "Promise<NativeError | null>")]
    pub fn pong(
        &self,
        env: Env,
        #[napi(ts_arg_type = "Uint8Array")] data: JsBytes,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        self.send(env, WsMessage::Pong(data.0.to_vec()))
    }

    /// Receives the next message. Resolves with it or with an error, and never rejects.
    #[napi(ts_return_type = "Promise<NativeWebSocketReceive>")]
    pub fn receive(&self, env: Env) -> napi::Result<AsyncBlock<Delivered<NativeWebSocketReceive>>> {
        let guard = InFlightGuard::register();
        let (reply, result) = oneshot::channel();
        let queued = self.receives.send(reply).is_ok();
        let work = async move {
            let received = match (queued, result.await) {
                (true, Ok(Ok(message))) => NativeWebSocketReceive::message(message),
                (true, Ok(Err(err))) => {
                    NativeWebSocketReceive::failed(NativeError::from_upstream(&err))
                }
                _ => NativeWebSocketReceive::failed(closed()),
            };
            Ok(Delivered::new(received, guard))
        };
        AsyncBlockBuilder::new(work).build(&env)
    }

    /// Sends a close frame and releases the connection, without waiting for the peer's reply.
    /// A receive already running gets the peer's close message; later ones end with an error.
    #[napi(ts_return_type = "Promise<NativeError | null>")]
    pub fn close(
        &self,
        env: Env,
        code: Option<u16>,
        reason: Option<String>,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        let guard = InFlightGuard::register();
        let close_info = code.map(|code| (code, reason.unwrap_or_default()));
        let (reply, result) = oneshot::channel();
        let queued = self.writes.send(Write::Close(close_info, reply)).is_ok();
        let work = async move { Ok(Delivered::new(reply_error(queued, result.await), guard)) };
        AsyncBlockBuilder::new(work).build(&env)
    }
}

impl NativeWebSocket {
    /// Queues a message for the writer.
    fn send(
        &self,
        env: Env,
        message: WsMessage,
    ) -> napi::Result<AsyncBlock<Delivered<Option<NativeError>>>> {
        let guard = InFlightGuard::register();
        let (reply, result) = oneshot::channel();
        let queued = self.writes.send(Write::Send(message, reply)).is_ok();
        let work = async move { Ok(Delivered::new(reply_error(queued, result.await), guard)) };
        AsyncBlockBuilder::new(work).build(&env)
    }
}

/// The error a command reported, if any; a command the driver never answered means the
/// connection is closed.
fn reply_error(
    queued: bool,
    result: Result<lkrequest::error::Result<()>, oneshot::error::RecvError>,
) -> Option<NativeError> {
    match (queued, result) {
        (true, Ok(Ok(()))) => None,
        (true, Ok(Err(err))) => Some(NativeError::from_upstream(&err)),
        _ => Some(closed()),
    }
}

/// The error for an operation on a connection that is no longer open.
fn closed() -> NativeError {
    NativeError::closed("the WebSocket connection is closed")
}

/// A handshake, validated and ready to send.
struct Handshake {
    url: String,
    headers: Vec<(String, String)>,
    protocols: Vec<String>,
    extensions: Vec<String>,
}

/// Performs the handshake and starts the reader and the writer. Never fails: errors become
/// outcomes.
async fn connect(
    session: Session,
    handshake: Handshake,
    cancel: Option<&CancelToken>,
) -> NativeWebSocketOutcome {
    let failed = |error| NativeWebSocketOutcome {
        socket: None,
        error: Some(error),
    };
    let Handshake {
        url,
        headers,
        protocols,
        extensions,
    } = handshake;
    let mut builder = session.websocket(&url);
    for (name, value) in &headers {
        builder = builder.header(name, value);
    }
    for protocol in &protocols {
        builder = builder.protocol(protocol);
    }
    for extension in &extensions {
        builder = builder.extension(extension);
    }
    tracing::debug!(url, "opening websocket");
    let connection = match until_cancelled(cancel, builder.connect()).await {
        Some(Ok(connection)) => connection,
        Some(Err(err)) => {
            tracing::error!(url, error = %err, "websocket handshake failed");
            return failed(NativeError::from_upstream(&err));
        }
        None => return failed(NativeError::aborted()),
    };
    let connection = Arc::new(connection);
    // Set once the connection is done; each task then stops as soon as it is idle.
    let done = Arc::new(CancelToken::default());
    let (writes, write_queue) = mpsc::unbounded_channel();
    let (receives, receive_queue) = mpsc::unbounded_channel();
    tokio::spawn(write_loop(
        Arc::clone(&connection),
        write_queue,
        Arc::clone(&done),
    ));
    tokio::spawn(read_loop(connection, receive_queue, done));
    NativeWebSocketOutcome {
        socket: Some(NativeWebSocket {
            url,
            writes,
            receives,
        }),
        error: None,
    }
}

/// Runs the receives in call order until the connection is done.
async fn read_loop<S>(
    connection: Arc<WsConnection<S>>,
    mut queue: mpsc::UnboundedReceiver<Receive>,
    done: Arc<CancelToken>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    loop {
        let reply = tokio::select! {
            biased;
            () = done.cancelled() => break,
            reply = queue.recv() => match reply {
                Some(reply) => reply,
                None => break,
            },
        };
        // Never cut short, even by a close: the peer answers that with a close message.
        let received = connection.recv().await;
        let finished = matches!(received, Ok(WsMessage::Close(..)) | Err(_));
        let _ = reply.send(received);
        if finished {
            done.cancel();
            break;
        }
    }
    tracing::debug!("websocket reader stopped");
}

/// Runs the sends and the close in call order until the connection is done.
async fn write_loop<S>(
    connection: Arc<WsConnection<S>>,
    mut queue: mpsc::UnboundedReceiver<Write>,
    done: Arc<CancelToken>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    loop {
        let write = tokio::select! {
            biased;
            () = done.cancelled() => break,
            write = queue.recv() => match write {
                Some(write) => write,
                None => break,
            },
        };
        match write {
            Write::Send(message, reply) => {
                let _ = reply.send(connection.send(message).await);
            }
            Write::Close(close_info, reply) => {
                let close_info = close_info
                    .as_ref()
                    .map(|(code, reason)| (*code, reason.as_str()));
                let result = connection.close(close_info).await;
                // A rejected code or reason never reached the wire; the connection stays.
                let sent = result.is_ok();
                let _ = reply.send(result);
                if sent {
                    done.cancel();
                    break;
                }
            }
        }
    }
    tracing::debug!("websocket writer stopped");
}

/// Opens a WebSocket on `session`, counting the handshake as in flight. Invalid options
/// throw synchronously.
pub(crate) fn open(
    env: &Env,
    session: Session,
    url: String,
    options: NativeWebSocketOptions,
    abort: Option<&AbortHandle>,
) -> napi::Result<AsyncBlock<Delivered<NativeWebSocketOutcome>>> {
    let headers = match &options.headers {
        Some(headers) => pairs(headers, "headers")?
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
        None => Vec::new(),
    };
    let handshake = Handshake {
        url,
        headers,
        protocols: options.protocols.unwrap_or_default(),
        extensions: options.extensions.unwrap_or_default(),
    };
    let guard = InFlightGuard::register();
    let token = abort.map(AbortHandle::token);
    let work = async move {
        let outcome = connect(session, handshake, token.as_deref()).await;
        Ok(Delivered::new(outcome, guard))
    };
    AsyncBlockBuilder::new(work).build(env)
}
