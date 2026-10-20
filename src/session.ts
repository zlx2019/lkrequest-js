import { STATUS_CODES } from "node:http";
import type {
  NativeBody,
  NativePriority,
  NativeRequest,
  NativeResponse,
  NativeSession,
} from "../native/index.cjs";
import { CookieJar } from "./cookie-jar.js";
import type { TracedRequest } from "./diagnostics.js";
import { AbortError, RequestError } from "./errors.js";
import type { RequestHook, ResponseHook } from "./hooks.js";
import { AbortLink } from "./internal/abort.js";
import { type PreparedBody, prepareBody } from "./internal/body.js";
import {
  type Hooks,
  runRequestMiddleware,
  runResponseMiddleware,
} from "./internal/interceptors.js";
import { recordResponse } from "./internal/metrics-store.js";
import { callNative, fromNativeError } from "./internal/native-error.js";
import { flattenHeaders, flattenPairs, hasHeader, unflatten } from "./internal/pairs.js";
import { toNativeProtocolPolicy } from "./internal/protocol.js";
import { traceEnd, traceError, traceStart } from "./internal/tracing.js";
import type { Middleware } from "./middleware.js";
import { Response } from "./response.js";
import { StreamingResponse } from "./streaming-response.js";
import type {
  HttpVersion,
  PairsInput,
  PoolStats,
  PreconnectResult,
  PrefetchResult,
  RequestOptions,
  RequestPriority,
} from "./types.js";
import { WebSocketConnection, type WebSocketOptions } from "./websocket.js";

/** Options of the method shortcuts, which fix the method themselves. */
export type MethodOptions = Omit<RequestOptions, "method">;

/** @internal What a session needs besides its native handle. */
export interface SessionContext {
  /** Base that relative URLs are resolved against. */
  readonly baseUrl: string | undefined;
  /** The client's middleware followed by the session's. */
  readonly middleware: readonly Middleware[];
  /** The session's event hooks. */
  readonly hooks: Hooks;
}

/** The method, URL and headers of a request: the part middleware may change. */
interface RequestHead {
  readonly method: string;
  readonly url: string;
  /** Flat name/value pairs, in send order. */
  readonly headers: string[];
}

/**
 * A browsing session: connections, cookies and settings shared by its requests. Create one
 * with `client.session()`.
 */
export class Session {
  /** The session's cookies, sent with matching requests and updated by responses. */
  readonly cookies: CookieJar;
  readonly #native: NativeSession;
  readonly #baseUrl: string | undefined;
  readonly #middleware: readonly Middleware[];
  readonly #hooks: Hooks;
  #closed = false;

  /** Sessions come from `Client#session()`; they cannot be constructed directly. */
  private constructor(nativeSession: NativeSession, context: SessionContext) {
    this.#native = nativeSession;
    this.#baseUrl = context.baseUrl;
    this.#middleware = context.middleware;
    this.#hooks = context.hooks;
    this.cookies = CookieJar.fromNative(nativeSession);
  }

  /** @internal Wraps a session created by the native layer. */
  static fromNative(nativeSession: NativeSession, context: SessionContext): Session {
    return new Session(nativeSession, context);
  }

  /**
   * Sends a request and resolves with its response. Failures reject with a `RequestError`
   * subclass; an HTTP error status does not (see `Response#throwForStatus()`).
   */
  async request(url: string | URL, options: RequestOptions = {}): Promise<Response> {
    const target = this.#resolve(url);
    this.#assertOpen(target);
    const { signal } = options;
    if (signal?.aborted) {
      throw new AbortError(undefined, { cause: signal.reason, url: target });
    }
    const body = await prepareBody(options);
    const abort = new AbortLink(signal);
    // Set while the exchange is under way, for the tracing channels.
    let traced: TracedRequest | undefined;
    try {
      const head = requestHead(target, options, body.contentType);
      this.#hooks.fireRequest({
        method: head.method,
        url: head.url,
        headers: unflatten(head.headers),
      });
      const [request, nativeBody] = await this.#prepare(head, options, body);
      traced = traceStart(request);
      const outcome = await callNative(() =>
        this.#native.request(request, nativeBody, abort.handle),
      );
      if (outcome.error) {
        throw fromNativeError(outcome.error, { url: target, signal, cause: body.sourceError() });
      }
      if (!outcome.response) {
        throw new RequestError("the native layer returned neither a response nor an error");
      }
      traceEnd(traced, {
        status: outcome.response.status,
        statusText: outcome.response.statusText,
        headers: unflatten(outcome.response.headers),
        url: outcome.response.url,
        httpVersion: outcome.response.httpVersion as HttpVersion,
        elapsed: outcome.response.elapsed,
      });
      traced = undefined;
      const nativeResponse = await this.#intercept(outcome.response);
      const response = Response.fromNative(nativeResponse);
      recordResponse(response.url, response.elapsed, nativeResponse.body.length, response.status);
      this.#hooks.fireResponse({
        status: response.status,
        url: response.url,
        elapsed: response.elapsed,
      });
      return response;
    } catch (error) {
      traceError(traced, error);
      throw error;
    } finally {
      abort.release();
      body.close();
    }
  }

  /**
   * Sends a request and resolves once the response headers arrive; the body is read as it
   * is consumed (`body`, `text()`, `bytes()`, ...), with backpressure.
   *
   * Unlike `request()`, this returns the first response as is: it follows no redirect, runs
   * no retry policy and no response middleware. `signal` also aborts reading the body.
   */
  async stream(url: string | URL, options: RequestOptions = {}): Promise<StreamingResponse> {
    const target = this.#resolve(url);
    this.#assertOpen(target);
    const { signal } = options;
    if (signal?.aborted) {
      throw new AbortError(undefined, { cause: signal.reason, url: target });
    }
    const body = await prepareBody(options);
    const abort = new AbortLink(signal);
    let traced: TracedRequest | undefined;
    try {
      const head = requestHead(target, options, body.contentType);
      const [request, nativeBody] = await this.#prepare(head, options, body);
      traced = traceStart(request);
      const outcome = await callNative(() =>
        this.#native.stream(request, nativeBody, abort.handle),
      );
      if (outcome.error) {
        throw fromNativeError(outcome.error, { url: target, signal, cause: body.sourceError() });
      }
      if (!outcome.response) {
        throw new RequestError("the native layer returned neither a response nor an error");
      }
      traceEnd(traced, {
        status: outcome.response.status,
        statusText: outcome.response.statusText,
        headers: unflatten(outcome.response.headers),
      });
      // The response takes the abort link over, for reading the body.
      return StreamingResponse.fromNative(outcome.response, target, abort);
    } catch (error) {
      traceError(traced, error);
      abort.release();
      throw error;
    } finally {
      body.close();
    }
  }

  /**
   * Opens a WebSocket connection with the session's fingerprint, cookies, proxy and
   * timeouts. Rejects with a `RequestError` subclass when the handshake fails.
   */
  async websocket(url: string | URL, options: WebSocketOptions = {}): Promise<WebSocketConnection> {
    const target = this.#resolve(url);
    this.#assertOpen(target);
    const { signal } = options;
    if (signal?.aborted) {
      throw new AbortError(undefined, { cause: signal.reason, url: target });
    }
    const abort = new AbortLink(signal);
    try {
      const nativeOptions = {
        ...(options.headers !== undefined && { headers: flattenHeaders(options.headers) }),
        ...(options.protocols !== undefined && { protocols: [...options.protocols] }),
        ...(options.extensions !== undefined && { extensions: [...options.extensions] }),
      };
      const outcome = await callNative(() =>
        this.#native.websocket(target, nativeOptions, abort.handle),
      );
      if (outcome.error) {
        throw fromNativeError(outcome.error, { url: target, signal });
      }
      if (!outcome.socket) {
        throw new RequestError("the native layer returned neither a socket nor an error");
      }
      return WebSocketConnection.fromNative(outcome.socket);
    } finally {
      abort.release();
    }
  }

  /** Sends a `GET` request. */
  get(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "GET" });
  }

  /** Sends a `POST` request. */
  post(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "POST" });
  }

  /** Sends a `PUT` request. */
  put(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "PUT" });
  }

  /** Sends a `DELETE` request. */
  delete(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "DELETE" });
  }

  /** Sends a `HEAD` request. */
  head(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "HEAD" });
  }

  /** Sends a `PATCH` request. */
  patch(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "PATCH" });
  }

  /** Sends an `OPTIONS` request. */
  options(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "OPTIONS" });
  }

  /**
   * Opens a connection to `url` ahead of the first request, so that request skips DNS, TCP
   * and TLS. Rejects with a `RequestError` subclass when the connection fails.
   */
  async preconnect(url: string | URL): Promise<void> {
    const target = this.#resolve(url);
    this.#assertOpen(target);
    const error = await this.#native.preconnect(target);
    if (error) {
      throw fromNativeError(error, { url: target });
    }
  }

  /** Opens connections to several URLs concurrently; never rejects for a failed one. */
  async preconnectMany(urls: Iterable<string | URL>): Promise<PreconnectResult[]> {
    const targets = Array.from(urls, (url) => this.#resolve(url));
    this.#assertOpen(targets[0]);
    const results = await this.#native.preconnectMany(targets);
    return results.map(({ url, error }) =>
      // Connecting fails only with request errors; abort and option errors cannot occur here.
      error
        ? { url, ok: false, error: fromNativeError(error, { url }) as RequestError }
        : { url, ok: true },
    );
  }

  /**
   * Warms connections to several URLs with `HEAD` requests, concurrently; never rejects for a
   * failed one.
   */
  async prefetch(urls: Iterable<string | URL>): Promise<PrefetchResult[]> {
    const targets = Array.from(urls, (url) => this.#resolve(url));
    this.#assertOpen(targets[0]);
    const results = await this.#native.prefetch(targets);
    return results.map(({ url, success, duration, error }) =>
      success
        ? { url, ok: true, duration }
        : {
            url,
            ok: false,
            duration,
            error: new RequestError(error ?? "prefetch failed", { url }),
          },
    );
  }

  /**
   * Adds a hook called before each request (`request()` and the method shortcuts); returns
   * the function that removes it.
   */
  onRequest(hook: RequestHook): () => void {
    return this.#hooks.addRequestHook(hook);
  }

  /** Adds a hook called after each successful request; returns the function that removes it. */
  onResponse(hook: ResponseHook): () => void {
    return this.#hooks.addResponseHook(hook);
  }

  /** Statistics of the session's connection pool. */
  poolStats(): PoolStats {
    return this.#native.poolStats();
  }

  /**
   * Closes every pooled connection; requests in flight finish normally. The connections leave
   * `poolStats()` at once, but `total` drops only after they have shut down, shortly after.
   */
  clearPool(): void {
    this.#native.clearPool();
  }

  /** Whether `close()` has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Closes the pooled connections and refuses further requests with a `RequestError` whose
   * code is `ERR_LK_SESSION_CLOSED`. Requests already in flight finish normally.
   */
  close(): void {
    this.#closed = true;
    this.#native.clearPool();
  }

  /** Closes the session, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }

  /** Runs the request middleware and builds the native request and body. */
  async #prepare(
    head: RequestHead,
    options: RequestOptions,
    body: PreparedBody,
  ): Promise<[NativeRequest, NativeBody | undefined]> {
    if (this.#middleware.length === 0) {
      return [toNativeRequest(head, options), body.native];
    }
    const original = body.native?.bytes;
    const changed = await runRequestMiddleware(this.#middleware, {
      method: head.method,
      url: head.url,
      headers: unflatten(head.headers).map(([name, value]) => [name, value]),
      body: original,
    });
    let nativeBody = body.native;
    if (changed.body !== original) {
      // New bytes replace any body, a streamed one included; clearing a buffered body drops it.
      nativeBody = changed.body === undefined ? undefined : { bytes: changed.body };
    }
    const changedHead = {
      method: changed.method,
      url: changed.url,
      headers: changed.headers.flat(),
    };
    return [toNativeRequest(changedHead, options), nativeBody];
  }

  /** Runs the response middleware over a native response. */
  async #intercept(nativeResponse: NativeResponse): Promise<NativeResponse> {
    if (this.#middleware.length === 0) {
      return nativeResponse;
    }
    const changed = await runResponseMiddleware(this.#middleware, {
      status: nativeResponse.status,
      headers: unflatten(nativeResponse.headers).map(([name, value]) => [name, value]),
      body: nativeResponse.body,
    });
    return {
      ...nativeResponse,
      status: changed.status,
      statusText:
        changed.status === nativeResponse.status
          ? nativeResponse.statusText
          : (STATUS_CODES[changed.status] ?? ""),
      headers: changed.headers.flat(),
      body: Buffer.isBuffer(changed.body)
        ? changed.body
        : Buffer.from(changed.body.buffer, changed.body.byteOffset, changed.body.byteLength),
    };
  }

  /** Resolves a request URL against the session's `baseUrl`. */
  #resolve(url: string | URL): string {
    return new URL(url, this.#baseUrl).href;
  }

  /** Throws when the session has been closed. */
  #assertOpen(url: string | undefined): void {
    if (this.#closed) {
      throw new RequestError("the session is closed", {
        code: "ERR_LK_SESSION_CLOSED",
        ...(url !== undefined && { url }),
      });
    }
  }
}

/** The method, URL and headers of a request, with the body's default `Content-Type`. */
function requestHead(
  url: string,
  options: RequestOptions,
  defaultContentType: string | undefined,
): RequestHead {
  const headers = options.headers === undefined ? [] : flattenHeaders(options.headers);
  if (defaultContentType !== undefined && !hasHeader(headers, "content-type")) {
    headers.push("content-type", defaultContentType);
  }
  // Methods are case-sensitive; normalize the standard ones like fetch does.
  return { method: normalizeMethod(options.method ?? "GET"), url, headers };
}

/** Flattens the public request options into the native shape. */
function toNativeRequest(head: RequestHead, options: RequestOptions): NativeRequest {
  const { auth } = options;
  return {
    method: head.method,
    url: head.url,
    headers: head.headers,
    ...(options.params !== undefined && { query: flattenParams(options.params) }),
    ...(options.cookies !== undefined && { cookies: flattenPairs(options.cookies) }),
    ...(options.cookieOverride !== undefined && {
      cookieOverride: flattenPairs(options.cookieOverride),
    }),
    ...(options.timeout !== undefined && { timeout: options.timeout }),
    ...(auth !== undefined && "bearer" in auth && { bearerAuth: auth.bearer }),
    ...(auth !== undefined &&
      "username" in auth && {
        basicAuthUser: auth.username,
        ...(auth.password !== undefined && { basicAuthPassword: auth.password }),
      }),
    ...(options.decompress !== undefined && { decompress: options.decompress }),
    ...(options.acceptEncoding !== undefined && { acceptEncoding: [...options.acceptEncoding] }),
    ...(options.headerOrder !== undefined && { headerOrder: [...options.headerOrder] }),
    ...(options.cookieOrder !== undefined && { cookieOrder: [...options.cookieOrder] }),
    ...(options.h3HeaderOrder !== undefined && { h3HeaderOrder: [...options.h3HeaderOrder] }),
    ...(options.priority !== undefined && { priority: toNativePriority(options.priority) }),
    ...(options.h2PriorityWeight !== undefined && { h2PriorityWeight: options.h2PriorityWeight }),
    ...(options.preferredHttpVersion !== undefined && {
      preferredHttpVersion: options.preferredHttpVersion,
    }),
    ...(options.idempotency !== undefined && { idempotency: options.idempotency }),
    ...(options.protocolPolicy !== undefined && {
      protocolPolicy: toNativeProtocolPolicy(options.protocolPolicy),
    }),
    ...(options.httpIntent !== undefined && { httpIntent: options.httpIntent }),
    ...(options.proxy !== undefined && { proxy: options.proxy }),
  };
}

/** Spells a priority as a preset name or an urgency with its flag. */
function toNativePriority(priority: RequestPriority): NativePriority {
  return typeof priority === "string" ? { preset: priority } : { ...priority };
}

/** Methods the Fetch standard upper-cases; anything else (`patch` too) is sent as written. */
const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

/** Upper-cases a standard method name given in any case. */
function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return NORMALIZED_METHODS.has(upper) ? upper : method;
}

/** Query parameters as flat pairs; a string is parsed like `new URLSearchParams(string)`. */
function flattenParams(init: URLSearchParams | string | PairsInput): string[] {
  return flattenPairs(typeof init === "string" ? new URLSearchParams(init) : init);
}
