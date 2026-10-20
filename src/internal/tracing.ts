import { channel } from "node:diagnostics_channel";
import type { NativeRequest } from "../../native/index.cjs";
import type {
  RequestEndMessage,
  RequestErrorMessage,
  RequestStartMessage,
  TracedRequest,
  TracedResponse,
} from "../diagnostics.js";
import { unflatten } from "./pairs.js";

// Channel objects are meant to be created once and kept; Node.js collects unreferenced ones.
const startChannel = channel("lkrequest:request:start");
const endChannel = channel("lkrequest:request:end");
const errorChannel = channel("lkrequest:request:error");

/**
 * Publishes the start of a request, unless nobody listens to the request channels. Returns
 * the request as the messages describe it, which `traceEnd` and `traceError` take back.
 */
export function traceStart(request: NativeRequest): TracedRequest | undefined {
  if (!(startChannel.hasSubscribers || endChannel.hasSubscribers || errorChannel.hasSubscribers)) {
    return undefined;
  }
  const traced: TracedRequest = {
    method: request.method,
    url: urlWithParams(request),
    headers: unflatten(request.headers ?? []),
  };
  if (startChannel.hasSubscribers) {
    const message: RequestStartMessage = { request: traced };
    startChannel.publish(message);
  }
  return traced;
}

/** Publishes the arrival of a request's response. */
export function traceEnd(traced: TracedRequest | undefined, response: TracedResponse): void {
  if (traced !== undefined && endChannel.hasSubscribers) {
    const message: RequestEndMessage = { request: traced, response };
    endChannel.publish(message);
  }
}

/** Publishes the failure of a request. */
export function traceError(traced: TracedRequest | undefined, error: unknown): void {
  if (traced !== undefined && errorChannel.hasSubscribers) {
    const message: RequestErrorMessage = {
      request: traced,
      error: error instanceof Error ? error : new Error(String(error)),
    };
    errorChannel.publish(message);
  }
}

/** The request's URL with its query parameters appended, as they go out. */
function urlWithParams(request: NativeRequest): string {
  if (request.query === undefined || request.query.length === 0) {
    return request.url;
  }
  const url = new URL(request.url);
  for (const [name, value] of unflatten(request.query)) {
    url.searchParams.append(name, value);
  }
  return url.href;
}
