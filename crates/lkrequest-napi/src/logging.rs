//! Log events of upstream and of this crate, forwarded to JavaScript.
//!
//! A process-wide tracing subscriber (installed on first use) filters events with an
//! `EnvFilter`, the directive syntax of lkrequest-py's `set_log_level`, and hands each
//! surviving event to the JavaScript sink set with [`set_log_sink`]. Until a filter is set
//! everything is off, so logging costs nothing by default.

use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use napi::Status;
use napi::threadsafe_function::{
    ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue,
};
use napi_derive::napi;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::{EnvFilter, Registry, reload};

use crate::error::invalid_arg;

/// Records waiting for the JavaScript thread. A sink that falls behind loses the newest
/// records rather than growing without bound.
const SINK_QUEUE_SIZE: usize = 4096;

/// The JavaScript sink: called with each record, never awaited, never keeps the process alive.
type LogSink = ThreadsafeFunction<
    NativeLogRecord,
    UnknownReturnValue,
    NativeLogRecord,
    Status,
    false,
    true,
    SINK_QUEUE_SIZE,
>;

/// The current sink; the most recent `setLogSink` call wins.
static SINK: Mutex<Option<LogSink>> = Mutex::new(None);

/// Handle for swapping the filter of the installed subscriber.
static FILTER: OnceLock<reload::Handle<EnvFilter, Registry>> = OnceLock::new();

/// One log event.
#[napi(object, object_from_js = false)]
pub struct NativeLogRecord {
    /// `error`, `warn`, `info`, `debug` or `trace`.
    pub level: String,
    /// Module path of the code that logged, for example `lkrequest::session`.
    pub target: String,
    /// The event's message.
    pub message: String,
    /// The event's other fields, formatted as text.
    pub fields: HashMap<String, String>,
    /// Milliseconds since the Unix epoch.
    pub timestamp: f64,
}

/// Sets which events are logged, as `EnvFilter` directives (`"info"`,
/// `"lkrequest=debug,lktls=trace"`, `"off"`). Installs the subscriber on first use; throws
/// for an invalid directive.
#[napi]
pub fn set_log_filter(directives: String) -> napi::Result<()> {
    let filter = EnvFilter::try_new(&directives)
        .map_err(|err| invalid_arg(format!("invalid log filter {directives:?}: {err}")))?;
    match FILTER.get() {
        Some(handle) => handle
            .reload(filter)
            .map_err(|err| invalid_arg(format!("cannot change the log filter: {err}"))),
        None => install(filter),
    }
}

/// Routes every log record to `sink`, replacing the previous one.
#[napi]
pub fn set_log_sink(#[napi(ts_arg_type = "(record: NativeLogRecord) => void")] sink: LogSink) {
    *SINK.lock().unwrap_or_else(PoisonError::into_inner) = Some(sink);
}

/// Logs a warning on behalf of the facade (a failing event hook, for example), so it passes
/// the same filter and reaches the same sink as native events.
#[napi]
pub fn log_facade_warning(message: String) {
    tracing::warn!(target: "lkrequest_napi::facade", "{message}");
}

/// Installs the process-wide subscriber with `filter`.
fn install(filter: EnvFilter) -> napi::Result<()> {
    let (filter, handle) = reload::Layer::new(filter);
    let subscriber = Registry::default().with(filter).with(JsLayer);
    tracing::subscriber::set_global_default(subscriber)
        .map_err(|err| invalid_arg(format!("cannot install the log subscriber: {err}")))?;
    // Only the first call reaches this point: `set_global_default` fails for any later one.
    let _ = FILTER.set(handle);
    Ok(())
}

/// Forwards events that passed the filter to the JavaScript sink.
struct JsLayer;

impl<S: Subscriber> Layer<S> for JsLayer {
    /// Converts the event and queues it for the JavaScript thread without waiting.
    fn on_event(&self, event: &Event<'_>, _context: Context<'_, S>) {
        let sink = SINK.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(sink) = sink.as_ref() else {
            return;
        };
        let metadata = event.metadata();
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let record = NativeLogRecord {
            level: level_name(*metadata.level()).to_owned(),
            target: metadata.target().to_owned(),
            message: visitor.message,
            fields: visitor.fields,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0),
        };
        // A full queue or a closing environment drops the record; logging must never block.
        let _ = sink.call(record, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// The lower-case name of a level.
fn level_name(level: Level) -> &'static str {
    match level {
        Level::ERROR => "error",
        Level::WARN => "warn",
        Level::INFO => "info",
        Level::DEBUG => "debug",
        Level::TRACE => "trace",
    }
}

/// Collects an event's message and fields as text.
#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: HashMap<String, String>,
}

impl Visit for FieldVisitor {
    /// Takes strings verbatim, without the quotes `Debug` would add.
    fn record_str(&mut self, field: &Field, value: &str) {
        self.store(field, value.to_owned());
    }

    /// Formats every other value with `Debug`.
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let mut text = String::new();
        let _ = write!(text, "{value:?}");
        self.store(field, text);
    }
}

impl FieldVisitor {
    /// Files a value under the message or under its field name.
    fn store(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = value;
        } else {
            self.fields.insert(field.name().to_owned(), value);
        }
    }
}
