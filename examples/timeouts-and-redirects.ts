// Timeouts and redirects
//
// Time limits for the phases of a request, and the ways to treat a redirect.
//
// Run: node examples/timeouts-and-redirects.ts (see examples/README.md)

import { Client, TimeoutError, TooManyRedirectsError } from "lkrequest";

// Each phase of a request can have its own limit, in milliseconds. `total` covers the whole
// request, redirects included.
const client = new Client({
  timeouts: { tcpConnect: 5_000, tlsHandshake: 5_000, ttfb: 10_000, total: 30_000 },
});

// A phase that runs over its limit fails with a `TimeoutError`.
const impatient = new Client({ timeouts: { ttfb: 500 } });
try {
  await impatient.get("https://httpbin.org/delay/3");
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log(error.code, error.phase);
  }
}

// Redirects are followed by default, and the hops are kept.
const followed = await client.session().get("https://httpbin.org/redirect/2");
console.log(followed.redirected, followed.url);
console.log(followed.history.map((hop) => `${hop.status} ${hop.url} -> ${hop.location}`));

// With `redirect: "manual"` the redirect response itself is returned.
const manual = client.session({ redirect: "manual" });
const redirect = await manual.get("https://httpbin.org/redirect/1");
console.log(redirect.status, redirect.headers.get("location"));

// `maxRedirects` caps a chain; `redirect: "error"` refuses to follow any.
try {
  await client.session({ maxRedirects: 1 }).get("https://httpbin.org/redirect/3");
} catch (error) {
  if (error instanceof TooManyRedirectsError) {
    console.log(error.code);
  }
}
