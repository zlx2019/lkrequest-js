import { BUCKETS_MS, resetStore, store } from "./internal/metrics-store.js";
import { native } from "./internal/native.js";

/** Metrics of one host. */
export interface HostMetrics {
  /** Requests that got a response. */
  readonly requests: number;
  /** Responses with a status of 400 or above. */
  readonly errors: number;
  /** Body bytes received. */
  readonly bytesReceived: number;
  /** Sum of the request durations, in milliseconds. */
  readonly durationSum: number;
  /**
   * Cumulative latency histogram: for each bucket bound in milliseconds (`"10"`, `"25"`, ...,
   * `"10000"`), the requests that took at most that long.
   */
  readonly durationBuckets: Readonly<Record<string, number>>;
}

/** A snapshot of the request metrics. */
export interface MetricsSnapshot {
  /** Requests that got a response. */
  readonly requestsTotal: number;
  /** Responses with a status of 400 or above. */
  readonly errorsTotal: number;
  /** Body bytes received. */
  readonly bytesReceivedTotal: number;
  /** The same counters per host. */
  readonly hosts: Readonly<Record<string, HostMetrics>>;
}

/** Upstream's transport counters, all zero in a build without the `telemetry` feature. */
export interface TransportMetrics {
  /** Bytes read from the network; a connection's bytes are added when it closes. */
  readonly bytesIn: number;
  /** Bytes written to the network; a connection's bytes are added when it closes. */
  readonly bytesOut: number;
  /** Requests completed. */
  readonly requestsTotal: number;
  /** Requests that ended in an error. */
  readonly requestsFailed: number;
  /** Connections open now. */
  readonly activeConnections: number;
  /** Connections opened so far. */
  readonly totalConnections: number;
}

/**
 * Request metrics of this process (of this JavaScript realm, with worker threads), from
 * `enableMetrics()`. Every buffered request that gets a response is counted per host;
 * requests that fail before a response, and streamed requests, are not.
 */
export class MetricsCollector {
  /** Collectors come from `enableMetrics()`. */
  private constructor() {}

  /** @internal The shared collector. */
  static readonly instance: MetricsCollector = new MetricsCollector();

  /** The counters so far. */
  snapshot(): MetricsSnapshot {
    const hosts: Record<string, HostMetrics> = {};
    for (const [host, counters] of store.hosts) {
      hosts[host] = {
        requests: counters.requests,
        errors: counters.errors,
        bytesReceived: counters.bytesReceived,
        durationSum: counters.durationSum,
        durationBuckets: Object.fromEntries(
          BUCKETS_MS.map((bound, index) => [String(bound), counters.buckets[index] ?? 0]),
        ),
      };
    }
    return {
      requestsTotal: store.requests,
      errorsTotal: store.errors,
      bytesReceivedTotal: store.bytesReceived,
      hosts,
    };
  }

  /** The counters in the Prometheus text exposition format; durations in seconds. */
  prometheusText(): string {
    const lines = [
      "# HELP lkrequest_requests_total Total number of HTTP requests.",
      "# TYPE lkrequest_requests_total counter",
      `lkrequest_requests_total ${store.requests}`,
      "# HELP lkrequest_errors_total Total number of failed HTTP requests.",
      "# TYPE lkrequest_errors_total counter",
      `lkrequest_errors_total ${store.errors}`,
      "# HELP lkrequest_bytes_received_total Total bytes received across all responses.",
      "# TYPE lkrequest_bytes_received_total counter",
      `lkrequest_bytes_received_total ${store.bytesReceived}`,
      "# HELP lkrequest_request_duration_seconds HTTP request duration in seconds.",
      "# TYPE lkrequest_request_duration_seconds histogram",
    ];
    for (const [host, counters] of store.hosts) {
      const label = host.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      BUCKETS_MS.forEach((bound, index) => {
        lines.push(
          `lkrequest_request_duration_seconds_bucket{host="${label}",le="${bound / 1000}"} ${counters.buckets[index] ?? 0}`,
        );
      });
      lines.push(
        `lkrequest_request_duration_seconds_bucket{host="${label}",le="+Inf"} ${counters.requests}`,
        `lkrequest_request_duration_seconds_sum{host="${label}"} ${counters.durationSum / 1000}`,
        `lkrequest_request_duration_seconds_count{host="${label}"} ${counters.requests}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  /** Sets every counter back to zero. */
  reset(): void {
    resetStore();
  }
}

/** Starts collecting request metrics and returns the collector; later calls return it again. */
export function enableMetrics(): MetricsCollector {
  store.enabled = true;
  return MetricsCollector.instance;
}

/** Upstream's process-wide transport counters (bytes on the wire, connections). */
export function metricsSnapshot(): TransportMetrics {
  return native.metricsSnapshot();
}
