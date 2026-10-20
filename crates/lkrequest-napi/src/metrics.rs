//! Process-wide transport counters from upstream's `telemetry` feature.
//!
//! The per-host request metrics of `enableMetrics()` live in the facade (lkrequest-py keeps
//! them in its binding layer too); only these counters come from upstream.

use napi_derive::napi;

/// Upstream's transport counters; all zero without the `telemetry` feature.
#[napi(object, object_from_js = false)]
pub struct NativeMetricsSnapshot {
    /// Bytes read from the network.
    pub bytes_in: f64,
    /// Bytes written to the network.
    pub bytes_out: f64,
    /// Requests sent.
    pub requests_total: f64,
    /// Requests that failed.
    pub requests_failed: f64,
    /// Connections open now.
    pub active_connections: f64,
    /// Connections opened so far.
    pub total_connections: f64,
}

/// Reads upstream's transport counters.
#[napi]
pub fn metrics_snapshot() -> NativeMetricsSnapshot {
    #[cfg(feature = "telemetry")]
    {
        let snapshot = lkrequest::telemetry::metrics_snapshot();
        NativeMetricsSnapshot {
            bytes_in: snapshot.bytes_in as f64,
            bytes_out: snapshot.bytes_out as f64,
            requests_total: snapshot.requests_total as f64,
            requests_failed: snapshot.requests_failed as f64,
            active_connections: snapshot.active_connections as f64,
            total_connections: snapshot.total_connections as f64,
        }
    }
    #[cfg(not(feature = "telemetry"))]
    {
        NativeMetricsSnapshot {
            bytes_in: 0.0,
            bytes_out: 0.0,
            requests_total: 0.0,
            requests_failed: 0.0,
            active_connections: 0.0,
            total_connections: 0.0,
        }
    }
}
