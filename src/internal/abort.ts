import type { AbortHandle } from "../../native/index.cjs";
import { AbortError } from "../errors.js";
import { native } from "./native.js";

/**
 * Runs a native operation that resolves with `null` once `signal` aborts it, turning that into
 * an `AbortError` whose `cause` is the signal's reason. A signal that has already fired
 * rejects at once, before the operation starts.
 */
export async function abortable<T>(
  signal: AbortSignal | undefined,
  operation: (handle: AbortHandle | undefined) => Promise<T | null>,
): Promise<T> {
  if (signal?.aborted) {
    throw new AbortError(undefined, { cause: signal.reason });
  }
  const abort = new AbortLink(signal);
  try {
    const value = await operation(abort.handle);
    if (value === null) {
      throw new AbortError(undefined, { cause: abort.reason });
    }
    return value;
  } finally {
    abort.release();
  }
}

/**
 * Links an `AbortSignal` to a native abort handle for as long as an operation runs.
 *
 * The listener is added once and must be removed with `release()` when the operation ends,
 * so a long-lived signal does not keep finished work alive (impit leaked listeners this way).
 */
export class AbortLink {
  /** The native handle to pass along, absent without a signal. */
  readonly handle: AbortHandle | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #callbacks: Array<() => void> = [];
  readonly #onAbort = (): void => {
    this.handle?.abort();
    for (const callback of this.#callbacks) {
      callback();
    }
  };

  /** Starts listening to `signal`; aborts at once if it already fired. */
  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
    this.handle = signal ? new native.AbortHandle() : undefined;
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    // The signal may have fired while the caller was preparing the operation.
    if (signal?.aborted) {
      this.handle?.abort();
    }
  }

  /** Whether the signal has fired. */
  get aborted(): boolean {
    return this.#signal?.aborted ?? false;
  }

  /** The signal's reason, the `cause` of an `AbortError`. */
  get reason(): unknown {
    return this.#signal?.reason;
  }

  /** Also runs `callback` on abort, at once if the signal already fired. */
  onAbort(callback: () => void): void {
    if (this.aborted) {
      callback();
    } else {
      this.#callbacks.push(callback);
    }
  }

  /** Stops listening; the operation is over. */
  release(): void {
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#callbacks.length = 0;
  }
}
