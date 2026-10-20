/**
 * The messages lkrequest publishes on `node:diagnostics_channel`, for tracing and APM tools.
 *
 * Three channels carry them, one logical request at a time (retries and redirects happen
 * inside it):
 *
 * - `lkrequest:request:start` ({@link RequestStartMessage}): the request is about to be sent.
 * - `lkrequest:request:end` ({@link RequestEndMessage}): the response headers arrived.
 * - `lkrequest:request:error` ({@link RequestErrorMessage}): the request failed or was aborted.
 *
 * A request ends with exactly one of the last two. The `request` object is the same in all of a
 * request's messages, so a subscriber can correlate them with a `WeakMap`.
 *
 * Messages are published by `session.request()` and its method shortcuts, `session.stream()`
 * and the `Client` methods. They are not published for WebSocket handshakes, `preconnect()`
 * and `prefetch()`. Nothing is built while a channel has no subscriber.
 *
 * Subscribers run synchronously on the request's path and must not change the messages. An
 * exception a subscriber throws does not affect the request: Node.js reports it as an
 * uncaught exception on the next tick.
 *
 * @example
 * ```ts
 * import { subscribe } from "node:diagnostics_channel";
 * import type { RequestEndMessage } from "lkrequest";
 *
 * subscribe("lkrequest:request:end", (message) => {
 *   const { request, response } = message as RequestEndMessage;
 *   console.log(request.method, request.url, response.status);
 * });
 * ```
 *
 * @module
 */

import type { HttpVersion } from "./types.js";

/** The request a message is about, as it is sent. */
export interface TracedRequest {
  /** HTTP method. */
  readonly method: string;
  /** Absolute URL, with the `params` option appended. */
  readonly url: string;
  /**
   * The headers of the request after middleware, in order. Headers the client adds on its own
   * (the preset's, `defaultHeaders`, cookies, `Content-Length`) are not included.
   */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** The response a message is about, as the server sent it (before response middleware). */
export interface TracedResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Standard reason phrase of the status. */
  readonly statusText: string;
  /** Response headers as name/value pairs, lower-case names, duplicates kept. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** Final URL, after redirects. Not set for `session.stream()`. */
  readonly url?: string;
  /** HTTP version the response arrived over. Not set for `session.stream()`. */
  readonly httpVersion?: HttpVersion;
  /** Wall-clock time of the whole exchange, in milliseconds. Not set for `session.stream()`. */
  readonly elapsed?: number;
}

/** Published on `lkrequest:request:start`. */
export interface RequestStartMessage {
  /** The request about to be sent. */
  readonly request: TracedRequest;
}

/** Published on `lkrequest:request:end`, when the response headers arrive. */
export interface RequestEndMessage {
  /** The request, the same object as in the start message. */
  readonly request: TracedRequest;
  /** The response; a streamed body has not been read yet. */
  readonly response: TracedResponse;
}

/** Published on `lkrequest:request:error`. */
export interface RequestErrorMessage {
  /** The request, the same object as in the start message. */
  readonly request: TracedRequest;
  /** The error the caller gets: a `RequestError`, an `AbortError`, or a `TypeError`. */
  readonly error: Error;
}
