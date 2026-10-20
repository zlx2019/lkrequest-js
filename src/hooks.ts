/**
 * Event hooks: observers notified around each request, which cannot change it.
 *
 * @module
 */

/** What an `onRequest` hook is told before a request is sent. */
export interface RequestEvent {
  /** HTTP method. */
  readonly method: string;
  /** Request URL. */
  readonly url: string;
  /** Headers the caller gave the request, in order. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** What an `onResponse` hook is told after a response arrives. */
export interface ResponseEvent {
  /** HTTP status code. */
  readonly status: number;
  /** Final URL, after redirects. */
  readonly url: string;
  /** Wall-clock time of the whole exchange, in milliseconds. */
  readonly elapsed: number;
}

/**
 * Called before each request. Its return value is ignored; an error it throws, or a Promise
 * it returns that rejects, is logged as a warning and does not affect the request.
 */
export type RequestHook = (event: RequestEvent) => void | Promise<void>;

/** Called after each successful request, with the same error handling as `RequestHook`. */
export type ResponseHook = (event: ResponseEvent) => void | Promise<void>;
