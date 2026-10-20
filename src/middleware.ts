/**
 * Request and response middleware, run around each request like upstream's middleware chain.
 *
 * @module
 */

/** The request as middleware sees and may change it. */
export interface MiddlewareRequest {
  /** HTTP method. */
  method: string;
  /** Request URL, before `params` are appended. */
  url: string;
  /** Request headers in send order, the default `Content-Type` included. */
  headers: Array<[string, string]>;
  /**
   * The body when it is held in memory; `undefined` for `FormData`, streamed bodies and
   * requests without one. Setting bytes replaces whatever body the request had.
   */
  body: Uint8Array | undefined;
}

/** The response as middleware sees and may change it. */
export interface MiddlewareResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers; names are lower-case. */
  headers: Array<[string, string]>;
  /** The decompressed body. */
  body: Uint8Array;
}

/**
 * A pair of interceptors around each request. `onRequest` runs once per logical request,
 * before redirects and retries; `onResponse` runs on the final response. Each may change the
 * object it receives in place or return a replacement. A middleware that throws fails the
 * request with that error.
 *
 * The client's middleware runs before the session's for requests, and the chain runs in
 * reverse for responses (the onion model). Streamed requests (`session.stream()`) run
 * `onRequest` only.
 */
export interface Middleware {
  /** Name for logs and debugging. */
  readonly name?: string;
  /** Inspects or changes a request before it is sent. */
  onRequest?(
    request: MiddlewareRequest,
  ): MiddlewareRequest | undefined | Promise<MiddlewareRequest | undefined>;
  /** Inspects or changes a response before the caller receives it. */
  onResponse?(
    response: MiddlewareResponse,
  ): MiddlewareResponse | undefined | Promise<MiddlewareResponse | undefined>;
}
