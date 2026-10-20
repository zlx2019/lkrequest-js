// Diagnostics
//
// What a response says about how it reached you, and the tracing events every request
// publishes on `node:diagnostics_channel`, which APM tools subscribe to.
//
// Run: node examples/diagnostics.ts (see examples/README.md)

import { subscribe } from "node:diagnostics_channel";
import {
  Client,
  type RequestEndMessage,
  type RequestErrorMessage,
  type RequestStartMessage,
  type TracedRequest,
} from "lkrequest";

const session = new Client().session();
const url = "https://httpbin.org/get";

// 1. A response carries the timings of its phases and the details of the transport. A phase
// that did not run is missing: the second request reuses the connection of the first, so it
// has no DNS, TCP or TLS time.
const first = await session.get(url);
console.log(first.diagnostics);
const second = await session.get(url);
console.log(second.diagnostics);
console.log(`${second.elapsed.toFixed(0)} ms by the wall clock, over HTTP/${second.httpVersion}`);

// 2. A request publishes `start` when it is about to be sent, then either `end` (the response
// headers arrived) or `error`. The `request` object is the same in all of them, so a WeakMap
// pairs the events of one request.
const startedAt = new WeakMap<TracedRequest, number>();

subscribe("lkrequest:request:start", (message) => {
  const { request } = message as RequestStartMessage;
  startedAt.set(request, performance.now());
});

subscribe("lkrequest:request:end", (message) => {
  const { request, response } = message as RequestEndMessage;
  const took = performance.now() - (startedAt.get(request) ?? 0);
  console.log(`${request.method} ${request.url} -> ${response.status} in ${took.toFixed(0)} ms`);
});

subscribe("lkrequest:request:error", (message) => {
  const { request, error } = message as RequestErrorMessage;
  console.log(`${request.method} ${request.url} failed: ${error.name}`);
});

await session.get(url);
// An error status is still a response, so it ends with `end`.
await session.get("https://httpbin.org/status/404");
// A request that fails ends with `error`.
await session.get("https://httpbin.org/delay/3", { timeout: 500 }).catch(() => undefined);
