import { describe, expect, it } from "vitest";
import { enableMetrics, MetricsCollector, metricsSnapshot } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { waitFor } from "./support/helpers.js";

// Metrics are process-wide, so every assertion about them lives in this one file (test files
// run in separate processes).
const session = testClient().session();

describe("enableMetrics", () => {
  it("counts nothing before it is called", async () => {
    await session.get(serverUrl("/get"));
    const metrics = enableMetrics();
    expect(metrics).toBeInstanceOf(MetricsCollector);
    expect(metrics.snapshot().requestsTotal).toBe(0);
  });

  it("returns the same collector every time", () => {
    expect(enableMetrics()).toBe(enableMetrics());
  });

  it("counts requests, errors and bytes per host", async () => {
    const metrics = enableMetrics();
    metrics.reset();
    await session.get(serverUrl("/bytes/100"));
    await session.get(serverUrl("/status/404"));
    const snapshot = metrics.snapshot();
    expect(snapshot).toMatchObject({ requestsTotal: 2, errorsTotal: 1, bytesReceivedTotal: 100 });
    const host = snapshot.hosts["127.0.0.1"];
    expect(host).toMatchObject({ requests: 2, errors: 1, bytesReceived: 100 });
    expect(host?.durationSum).toBeGreaterThan(0);
    expect(Object.keys(host?.durationBuckets ?? {})).toEqual([
      "10",
      "25",
      "50",
      "100",
      "250",
      "500",
      "1000",
      "2500",
      "5000",
      "10000",
    ]);
    // Cumulative: the largest bucket holds every request that was not slower than 10 s.
    expect(host?.durationBuckets["10000"]).toBe(2);
  });

  it("leaves out requests that got no response, and streamed ones", async () => {
    const metrics = enableMetrics();
    metrics.reset();
    await expect(session.get(serverUrl("/delay/2"), { timeout: 100 })).rejects.toThrow();
    await (await session.stream(serverUrl("/get"))).text();
    expect(metrics.snapshot().requestsTotal).toBe(0);
  });

  it("renders the Prometheus text format in seconds", async () => {
    const metrics = enableMetrics();
    metrics.reset();
    await session.get(serverUrl("/get"));
    const text = metrics.prometheusText();
    expect(text).toContain("# TYPE lkrequest_requests_total counter\nlkrequest_requests_total 1\n");
    expect(text).toContain('lkrequest_request_duration_seconds_bucket{host="127.0.0.1",le="0.01"}');
    expect(text).toContain(
      'lkrequest_request_duration_seconds_bucket{host="127.0.0.1",le="+Inf"} 1',
    );
    expect(text).toMatch(/lkrequest_request_duration_seconds_count\{host="127\.0\.0\.1"\} 1\n$/);
  });

  it("resets every counter", async () => {
    const metrics = enableMetrics();
    await session.get(serverUrl("/get"));
    metrics.reset();
    expect(metrics.snapshot()).toEqual({
      requestsTotal: 0,
      errorsTotal: 0,
      bytesReceivedTotal: 0,
      hosts: {},
    });
  });
});

describe("metricsSnapshot", () => {
  it("reports upstream's transport counters", async () => {
    // The test build enables the `telemetry` feature.
    const before = metricsSnapshot();
    const fresh = testClient().session();
    await fresh.get(serverUrl("/get"));
    const after = metricsSnapshot();
    expect(after.requestsTotal).toBeGreaterThan(before.requestsTotal);
    expect(after.totalConnections).toBeGreaterThan(before.totalConnections);
    // Byte counts are added up when a connection closes.
    fresh.clearPool();
    await waitFor(() => metricsSnapshot().bytesIn > before.bytesIn);
    expect(metricsSnapshot().bytesOut).toBeGreaterThan(before.bytesOut);
  });
});
