import type { NativeLogRecord } from "../native/index.cjs";
import { native } from "./internal/native.js";
import { callNative } from "./internal/native-error.js";

/** Severity of a log record. */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** One log event of lkrequest or of the Rust crates under it. */
export interface LogRecord {
  /** Severity. */
  readonly level: LogLevel;
  /** Module path of the code that logged, for example `lkrequest::session`. */
  readonly target: string;
  /** The event's message. */
  readonly message: string;
  /** The event's other fields, as text. */
  readonly fields: Readonly<Record<string, string>>;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: number;
}

/** Receives log records. */
export type LogListener = (record: LogRecord) => void;

const listeners = new Set<LogListener>();
let sinkInstalled = false;

/**
 * Sets which events are logged, with the directive syntax of Rust's `tracing` `EnvFilter`:
 * a level (`"info"`), per-target levels (`"lkrequest=debug,lktls=trace"`), or `"off"`.
 * Logging is off until this is called.
 *
 * Records go to the {@link onLog} listeners, or to stderr while there are none. Logging is
 * process-wide: in a process with worker threads, the thread that called this last receives
 * the records. Throws `TypeError` for an invalid directive.
 */
export function setLogLevel(directives: string): void {
  installSink();
  callNative(() => native.setLogFilter(directives));
}

/**
 * Registers a listener for log records, replacing the default stderr output while any
 * listener is registered (useful to forward records to pino or another logger). Returns a
 * function that removes the listener.
 */
export function onLog(listener: LogListener): () => void {
  installSink();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Points the native sink at this module's dispatcher, once per thread. */
function installSink(): void {
  if (!sinkInstalled) {
    native.setLogSink(dispatch);
    sinkInstalled = true;
  }
}

/** Hands one record to every listener, or prints it when there is none. */
function dispatch(raw: NativeLogRecord): void {
  const record = raw as LogRecord;
  if (listeners.size === 0) {
    process.stderr.write(`${format(record)}\n`);
    return;
  }
  for (const listener of listeners) {
    try {
      listener(record);
    } catch (error) {
      // A failing listener must not break logging for the others.
      process.emitWarning(`lkrequest log listener threw: ${String(error)}`);
    }
  }
}

/** Formats a record as one compact line: time, level, target, message, then fields. */
function format(record: LogRecord): string {
  const fields = Object.entries(record.fields).map(([name, value]) => ` ${name}=${value}`);
  const time = new Date(record.timestamp).toISOString();
  return `${time} ${record.level.toUpperCase().padStart(5)} ${record.target}: ${record.message}${fields.join("")}`;
}
