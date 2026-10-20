// Connection prewarming
//
// Opening a connection costs a DNS lookup, a TCP handshake and a TLS handshake. Do that ahead of
// time, and the first request skips all three.
//
// Run: node examples/connection-prewarming.ts (see examples/README.md)

import { Client } from "lkrequest";

const client = new Client({ preset: "chrome_155" });
const url = "https://httpbin.org/get";

// A cold session connects on its first request. A warm one has connected already.
const cold = client.session();
const warm = client.session();

console.log(warm.poolStats().total); // 0 connections
await warm.preconnect(url);
console.log(warm.poolStats().total); // 1 connection, ready

console.log("cold:", Math.round((await cold.get(url)).elapsed), "ms");
console.log("warm:", Math.round((await warm.get(url)).elapsed), "ms");

// Several hosts at once. A failure shows up in its own result instead of rejecting.
const results = await client
  .session()
  .preconnectMany(["https://example.com", "https://httpbin.org"]);
for (const result of results) {
  console.log(result.url, result.ok);
}

// `prefetch` goes one step further and sends a HEAD request to each URL.
const prefetched = await client.session().prefetch(["https://example.com"]);
console.log(
  prefetched.map((result) => `${result.url} ${result.ok} ${Math.round(result.duration)} ms`),
);
