// Metrics
//
// Counters for the requests your process makes, per host, in a form Prometheus can scrape, and
// the transport counters of the Rust library underneath.
//
// Run: node examples/metrics.ts (see examples/README.md)

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, enableMetrics, metricsSnapshot } from "lkrequest";

const session = new Client().session();

// 1. Nothing is counted until you ask. From then on, every request that gets a response is.
// A request that fails before any response, and a streamed one, are not.
const metrics = enableMetrics();
await session.get("https://httpbin.org/get");
await session.get("https://httpbin.org/get");
await session.get("https://httpbin.org/status/404");

// 2. The totals, and the same counters for each host. `errors` counts statuses of 400 and
// above. `durationBuckets` is a cumulative histogram: the requests that took at most that many
// milliseconds.
const snapshot = metrics.snapshot();
console.log(snapshot.requestsTotal, snapshot.errorsTotal, snapshot.bytesReceivedTotal);
for (const [host, counters] of Object.entries(snapshot.hosts)) {
  const mean = counters.durationSum / counters.requests;
  console.log(host, `${counters.requests} requests, ${mean.toFixed(0)} ms on average`);
  console.log(counters.durationBuckets);
}

// 3. The same counters in Prometheus's text format, durations in seconds. Serve it from a
// /metrics endpoint and point Prometheus at it.
const server = createServer((request, response) => {
  if (request.url === "/metrics") {
    response.setHeader("content-type", "text/plain; version=0.0.4");
    response.end(metrics.prometheusText());
  } else {
    response.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const scraped = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
// The histogram has a line per bucket and host; leave those out here.
const samples = scraped.split("\n").filter((line) => line && !/^#|_bucket/.test(line));
console.log(samples);
server.close();

// 4. `reset()` sets every counter back to zero.
metrics.reset();
console.log(metrics.snapshot().requestsTotal);

// 5. The Rust library counts the requests, the connections and the bytes on the wire, for the
// whole process. A connection's bytes are added when it closes, which takes a moment after the
// session is closed.
session.close();
await sleep(500);
console.log(metricsSnapshot());
