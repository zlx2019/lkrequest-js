/**
 * Per-host request metrics behind `enableMetrics()`, ported from lkrequest-py's
 * `src/metrics.rs`: counts, errors, bytes and a cumulative latency histogram per host.
 */

/** Upper bounds of the latency histogram buckets, in milliseconds. */
export const BUCKETS_MS: readonly number[] = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000,
];

/** Counters of one host. */
export interface HostCounters {
  requests: number;
  errors: number;
  bytesReceived: number;
  /** Sum of the request durations, in milliseconds. */
  durationSum: number;
  /** Requests at most as slow as each bucket bound, in `BUCKETS_MS` order. */
  readonly buckets: number[];
}

/** All the counters, plus whether recording is on. */
export interface MetricsStore {
  enabled: boolean;
  requests: number;
  errors: number;
  bytesReceived: number;
  readonly hosts: Map<string, HostCounters>;
}

/** The process-wide (per JavaScript realm) metrics. */
export const store: MetricsStore = {
  enabled: false,
  requests: 0,
  errors: 0,
  bytesReceived: 0,
  hosts: new Map(),
};

/** Records one response once metrics are enabled; status 400 and above counts as an error. */
export function recordResponse(url: string, elapsed: number, bytes: number, status: number): void {
  if (!store.enabled) {
    return;
  }
  const isError = status >= 400;
  store.requests += 1;
  store.bytesReceived += bytes;
  if (isError) {
    store.errors += 1;
  }
  const host = hostOf(url);
  let counters = store.hosts.get(host);
  if (!counters) {
    counters = {
      requests: 0,
      errors: 0,
      bytesReceived: 0,
      durationSum: 0,
      buckets: BUCKETS_MS.map(() => 0),
    };
    store.hosts.set(host, counters);
  }
  counters.requests += 1;
  counters.bytesReceived += bytes;
  counters.durationSum += elapsed;
  if (isError) {
    counters.errors += 1;
  }
  BUCKETS_MS.forEach((bound, index) => {
    if (elapsed <= bound) {
      counters.buckets[index] = (counters.buckets[index] ?? 0) + 1;
    }
  });
}

/** Clears every counter. */
export function resetStore(): void {
  store.requests = 0;
  store.errors = 0;
  store.bytesReceived = 0;
  store.hosts.clear();
}

/** The host a URL names, or `unknown`. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}
