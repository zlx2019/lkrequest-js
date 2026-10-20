import type { NativeError, NativeWebSocket, NativeWebSocketReceive } from "../native/index.cjs";
import type { RequestError } from "./errors.js";
import { fromNativeError } from "./internal/native-error.js";
import type { HeadersInput } from "./types.js";

/** Options of `Session#websocket()`. */
export interface WebSocketOptions {
  /** Extra handshake headers. A name given more than once keeps only its last value. */
  readonly headers?: HeadersInput;
  /** Subprotocols to offer, in preference order. */
  readonly protocols?: readonly string[];
  /** Extensions to offer in `Sec-WebSocket-Extensions`. */
  readonly extensions?: readonly string[];
  /** Aborts the handshake; it then rejects with `AbortError`. */
  readonly signal?: AbortSignal;
}

/** A message received on a WebSocket connection. */
export type WebSocketMessage =
  | { readonly type: "text"; readonly data: string }
  | { readonly type: "binary" | "ping" | "pong"; readonly data: Buffer }
  | { readonly type: "close"; readonly code?: number; readonly reason: string };

const EMPTY = new Uint8Array(0);

/**
 * An open WebSocket connection, from `Session#websocket()`. Iterating it with `for await`
 * yields every message and ends after the peer's close message.
 *
 * Sending does not wait for receiving: while a `receive()` (or the iteration) waits for a
 * message, `send()` and `close()` go out at once. Sends run in call order, and so do
 * receives. Incoming pings are answered automatically.
 *
 * @example
 * ```ts
 * const ws = await session.websocket("wss://example.com/chat");
 * await ws.send("hello");
 * for await (const message of ws) {
 *   if (message.type === "text") console.log(message.data);
 * }
 * ```
 */
export class WebSocketConnection implements AsyncIterable<WebSocketMessage> {
  /** URL the connection was opened to. */
  readonly url: string;
  readonly #native: NativeWebSocket;
  #closing = false;
  #closed = false;

  /** Connections come from `Session#websocket()`. */
  private constructor(nativeSocket: NativeWebSocket) {
    this.#native = nativeSocket;
    this.url = nativeSocket.url;
  }

  /** @internal Wraps a connection opened by the native layer. */
  static fromNative(nativeSocket: NativeWebSocket): WebSocketConnection {
    return new WebSocketConnection(nativeSocket);
  }

  /** Whether the connection has been closed, by either side. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Sends a text message for a string, a binary message for bytes. */
  async send(data: string | Uint8Array): Promise<void> {
    const error =
      typeof data === "string"
        ? await this.#native.sendText(data)
        : await this.#native.sendBinary(data);
    this.#check(error);
  }

  /** Sends a ping frame. */
  async ping(data: Uint8Array = EMPTY): Promise<void> {
    this.#check(await this.#native.ping(data));
  }

  /** Sends a pong frame. */
  async pong(data: Uint8Array = EMPTY): Promise<void> {
    this.#check(await this.#native.pong(data));
  }

  /** Receives the next message; rejects with a `RequestError` once the connection is gone. */
  async receive(): Promise<WebSocketMessage> {
    const received = await this.#native.receive();
    if (received.error) {
      this.#closed = true;
      throw this.#error(received.error);
    }
    const message = toMessage(received);
    if (message.type === "close") {
      this.#closed = true;
    }
    return message;
  }

  /**
   * Sends a close frame (code 1000 by default) and releases the connection, without
   * waiting for the peer's reply. A code an endpoint may not send, or a reason over 123
   * bytes, rejects and leaves the connection open. A `receive()` already waiting gets the
   * peer's close message; later ones reject.
   */
  async close(code?: number, reason?: string): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closing = true;
    const error = await this.#native.close(code, reason);
    if (error && error.kind !== "connection_closed") {
      this.#closing = false;
      throw this.#error(error);
    }
    this.#closed = true;
  }

  /** Yields messages until the peer closes the connection or `close()` is called. */
  async *[Symbol.asyncIterator](): AsyncGenerator<WebSocketMessage, void, undefined> {
    while (!this.#closed) {
      let message: WebSocketMessage;
      try {
        message = await this.receive();
      } catch (error) {
        // Ending the iteration is what closing the connection locally asks for.
        if (this.#closing) {
          return;
        }
        throw error;
      }
      yield message;
    }
  }

  /** Closes the connection, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Throws the error an operation reported, if any. */
  #check(error: NativeError | null): void {
    if (error) {
      throw this.#error(error);
    }
  }

  /** The public error for a failed operation. */
  #error(error: NativeError): RequestError {
    // Connection operations fail only with request errors.
    return fromNativeError(error, { url: this.url }) as RequestError;
  }
}

/** Converts a received native message. */
function toMessage(received: NativeWebSocketReceive): WebSocketMessage {
  switch (received.kind) {
    case "text":
      return { type: "text", data: received.text ?? "" };
    case "close":
      return {
        type: "close",
        ...(received.code != null && { code: received.code }),
        reason: received.reason ?? "",
      };
    default:
      return {
        type: received.kind as "binary" | "ping" | "pong",
        data: received.data ?? Buffer.alloc(0),
      };
  }
}
