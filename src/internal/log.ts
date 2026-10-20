import { native } from "./native.js";

/** The message of a caught value, whatever was thrown. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Logs a warning for a failure in a user callback that must not reach the caller. It passes
 * the same filter and reaches the same listeners as the native layer's own log events.
 */
export function warnFailure(what: string, error: unknown): void {
  native.logFacadeWarning(`${what} failed: ${describeError(error)}`);
}
