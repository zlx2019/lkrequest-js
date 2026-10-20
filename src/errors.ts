/** Machine-readable codes carried by lkrequest errors in their `code` property. */
export type ErrorCode =
  | "ERR_LK_REQUEST"
  | "ERR_LK_TLS"
  | "ERR_LK_PROXY"
  | "ERR_LK_HTTP_STATUS"
  | "ERR_LK_CONNECTION"
  | "ERR_LK_TIMEOUT"
  | "ERR_LK_TOO_MANY_REDIRECTS"
  | "ERR_LK_RESOURCE_LIMIT"
  | "ERR_LK_JSON_DECODE"
  | "ERR_LK_SESSION_CLOSED"
  | "ABORT_ERR";

/** Details shared by every request error, all optional. */
export interface RequestErrorOptions {
  /** Underlying cause, chained through the standard `Error#cause`. */
  readonly cause?: unknown;
  /** Machine-readable code; each class supplies its own default. */
  readonly code?: ErrorCode;
  /** Name of the upstream error variant, e.g. `ConnectionClosed`. */
  readonly kind?: string;
  /** Connection phase in which the failure happened, e.g. `tls` or `ttfb`. */
  readonly phase?: string;
  /** Whether retrying the request may succeed. */
  readonly retryable?: boolean;
  /** Whether the request can be sent again without side effects. */
  readonly safeToReplay?: boolean;
  /** URL of the request that failed. */
  readonly url?: string;
}

/** Base class of every error raised for a failed request. */
export class RequestError extends Error {
  static {
    RequestError.prototype.name = "RequestError";
  }

  /** Machine-readable error code. */
  readonly code: ErrorCode;
  /** Whether retrying the request may succeed. */
  readonly retryable: boolean;
  /** Whether the request can be sent again without side effects. */
  readonly safeToReplay: boolean;
  /** Name of the upstream error variant, when known. */
  declare readonly kind?: string;
  /** Connection phase in which the failure happened, when known. */
  declare readonly phase?: string;
  /** URL of the request that failed, when known. */
  declare readonly url?: string;

  /** Creates a request error; `options.code` defaults to `ERR_LK_REQUEST`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.code = options.code ?? "ERR_LK_REQUEST";
    this.retryable = options.retryable ?? false;
    this.safeToReplay = options.safeToReplay ?? false;
    if (options.kind !== undefined) this.kind = options.kind;
    if (options.phase !== undefined) this.phase = options.phase;
    if (options.url !== undefined) this.url = options.url;
  }
}

/** The TLS handshake with the origin failed. */
export class TlsError extends RequestError {
  static {
    TlsError.prototype.name = "TlsError";
  }

  /** Creates a TLS error; `options.code` defaults to `ERR_LK_TLS`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_TLS", ...options });
  }
}

/** Connecting through a proxy failed. */
export class ProxyError extends RequestError {
  static {
    ProxyError.prototype.name = "ProxyError";
  }

  /** Creates a proxy error; `options.code` defaults to `ERR_LK_PROXY`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_PROXY", ...options });
  }
}

/** The underlying connection failed or was closed. */
export class ConnectionError extends RequestError {
  static {
    ConnectionError.prototype.name = "ConnectionError";
  }

  /** Creates a connection error; `options.code` defaults to `ERR_LK_CONNECTION`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_CONNECTION", ...options });
  }
}

/** A configured timeout elapsed; `phase` tells which one. */
export class TimeoutError extends RequestError {
  static {
    TimeoutError.prototype.name = "TimeoutError";
  }

  /** Creates a timeout error; `options.code` defaults to `ERR_LK_TIMEOUT`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_TIMEOUT", ...options });
  }
}

/** The redirect limit was exceeded. */
export class TooManyRedirectsError extends RequestError {
  static {
    TooManyRedirectsError.prototype.name = "TooManyRedirectsError";
  }

  /** Creates a redirect-limit error; `options.code` defaults to `ERR_LK_TOO_MANY_REDIRECTS`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_TOO_MANY_REDIRECTS", ...options });
  }
}

/** A configured resource limit, such as the maximum body size, was exceeded. */
export class ResourceLimitError extends RequestError {
  static {
    ResourceLimitError.prototype.name = "ResourceLimitError";
  }

  /** Creates a resource-limit error; `options.code` defaults to `ERR_LK_RESOURCE_LIMIT`. */
  constructor(message: string, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_RESOURCE_LIMIT", ...options });
  }
}

/** A response had a 4xx or 5xx status; raised by `throwForStatus()`. */
export class HttpStatusError extends RequestError {
  static {
    HttpStatusError.prototype.name = "HttpStatusError";
  }

  /** HTTP status code of the response. */
  readonly status: number;

  /** Creates an HTTP status error; `options.code` defaults to `ERR_LK_HTTP_STATUS`. */
  constructor(message: string, status: number, options: RequestErrorOptions = {}) {
    super(message, { code: "ERR_LK_HTTP_STATUS", ...options });
    this.status = status;
  }
}

/**
 * The operation was aborted through an `AbortSignal`.
 *
 * Mirrors Node's own abort errors: `name` is `AbortError`, `code` is `ABORT_ERR` and `cause`
 * holds the signal's `reason`.
 */
export class AbortError extends RequestError {
  static {
    AbortError.prototype.name = "AbortError";
  }

  /** Creates an abort error; `options.code` defaults to `ABORT_ERR`. */
  constructor(message = "The operation was aborted", options: RequestErrorOptions = {}) {
    super(message, { code: "ABORT_ERR", ...options });
  }
}

/**
 * A response body could not be parsed as JSON.
 *
 * Extends `SyntaxError`, which is what `Response#json()` throws in the Fetch standard.
 */
export class JsonDecodeError extends SyntaxError {
  static {
    JsonDecodeError.prototype.name = "JsonDecodeError";
  }

  /** Machine-readable error code. */
  readonly code: "ERR_LK_JSON_DECODE" = "ERR_LK_JSON_DECODE";

  /** Creates a JSON decode error, usually wrapping the parser's `SyntaxError` as `cause`. */
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
  }
}
