import type { NativeError } from "../../native/index.cjs";
import {
  AbortError,
  ConnectionError,
  type ErrorCode,
  HttpStatusError,
  ProxyError,
  RequestError,
  type RequestErrorOptions,
  ResourceLimitError,
  TimeoutError,
  TlsError,
  TooManyRedirectsError,
} from "../errors.js";

/** Constructors of the errors that need no extra arguments, by code. */
const ERROR_CLASSES: Partial<
  Record<ErrorCode, new (message: string, options: RequestErrorOptions) => RequestError>
> = {
  ERR_LK_TIMEOUT: TimeoutError,
  ERR_LK_CONNECTION: ConnectionError,
  ERR_LK_TLS: TlsError,
  ERR_LK_PROXY: ProxyError,
  ERR_LK_TOO_MANY_REDIRECTS: TooManyRedirectsError,
  ERR_LK_RESOURCE_LIMIT: ResourceLimitError,
};

/** What the facade knows about a failed request beyond the native payload. */
export interface FailureContext {
  /** The URL that was requested, when known. */
  readonly url?: string | undefined;
  /** The request's signal, whose `reason` becomes the `cause` of an `AbortError`. */
  readonly signal?: AbortSignal | undefined;
  /** A lower-level error to report as `cause`, such as a failing body stream's. */
  readonly cause?: unknown;
}

/** Turns the native description of a failed request into the matching public error. */
export function fromNativeError(error: NativeError, context: FailureContext): Error {
  if (error.code === "ABORT_ERR") {
    return new AbortError(undefined, {
      cause: context.signal?.reason,
      ...(context.url !== undefined && { url: context.url }),
    });
  }
  if (error.code === "ERR_LK_INVALID_CONFIG") {
    return invalidConfig(error.message, context.cause);
  }
  const options: RequestErrorOptions = {
    ...(context.cause !== undefined && { cause: context.cause }),
    kind: error.kind,
    ...(error.phase != null && { phase: error.phase }),
    retryable: error.retryable,
    safeToReplay: error.safeToReplay,
    ...(context.url !== undefined && { url: context.url }),
  };
  if (error.code === "ERR_LK_HTTP_STATUS" && error.status != null) {
    return new HttpStatusError(error.message, error.status, options);
  }
  const ErrorClass = ERROR_CLASSES[error.code as ErrorCode];
  return ErrorClass
    ? new ErrorClass(error.message, options)
    : new RequestError(error.message, { ...options, code: "ERR_LK_REQUEST" });
}

/**
 * Calls into the native layer, turning a synchronous throw (always an argument the native
 * layer rejected) into a `TypeError` with code `ERR_LK_INVALID_CONFIG`.
 */
export function callNative<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw invalidConfig(error instanceof Error ? error.message : String(error), error);
  }
}

/** A `TypeError` with code `ERR_LK_INVALID_CONFIG`, for an option that cannot be used. */
export function invalidConfig(message: string, cause?: unknown): TypeError {
  const error = new TypeError(message, cause === undefined ? undefined : { cause });
  return Object.assign(error, { code: "ERR_LK_INVALID_CONFIG" });
}
