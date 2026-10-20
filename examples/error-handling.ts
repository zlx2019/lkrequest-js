// Error handling
//
// An error status and a failed request are different things. A request that fails throws a
// subclass of `RequestError`, which carries a `code` and says whether retrying may help.
//
// Run: node examples/error-handling.ts (see examples/README.md)

import { Client, ConnectionError, HttpStatusError, RequestError, TimeoutError } from "lkrequest";

const client = new Client();

// 1. The server answered with an error status. Nothing is thrown until you ask for it.
const res = await client.get("https://httpbin.org/status/503");
try {
  res.throwForStatus();
} catch (error) {
  if (error instanceof HttpStatusError) {
    console.log(error.code, error.status); // ERR_LK_HTTP_STATUS 503
  }
}

// 2. The request did not finish in time.
try {
  await client.get("https://httpbin.org/delay/5", { timeout: 1_000 });
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log(error.code, error.retryable); // ERR_LK_TIMEOUT true
  }
}

// 3. Nothing is listening at the address. `phase` says how far the connection got.
try {
  await client.get("http://127.0.0.1:9/");
} catch (error) {
  if (error instanceof ConnectionError) {
    console.log(error.code, error.phase, error.retryable); // ERR_LK_CONNECTION tcp_connect true
  }
}

// 4. You cancelled the request. A signal works like it does for `fetch`.
const controller = new AbortController();
setTimeout(() => controller.abort(), 500);
try {
  await client.get("https://httpbin.org/delay/5", { signal: controller.signal });
} catch (error) {
  // Every one of these classes extends `RequestError`, so one check catches them all.
  if (error instanceof RequestError) {
    console.log(error.name, error.code);
  }
}
