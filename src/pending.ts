import { native } from "./internal/native.js";

/**
 * Number of requests whose results have not been delivered yet, across every session in the
 * process. A request counts from the moment it reaches the native layer (right after its body
 * is prepared, which takes a moment for a `Blob` or `FormData` file) until its Promise settles.
 */
export function pendingRequests(): number {
  return native.pendingRequests();
}

/**
 * Waits until no request is pending, for example before a worker exits. Resolves `true` once
 * every pending request has settled, or `false` when `timeout` (milliseconds) elapsed first.
 */
export function drainPending(options: { readonly timeout?: number } = {}): Promise<boolean> {
  return native.drainPending(options.timeout);
}
