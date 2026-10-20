// Retries
//
// A session can retry a request that failed, or got a status such as 429 or 503. Pick a
// built-in strategy, or write the decision yourself. A request that is not safe to repeat,
// such as a POST, is never retried.
//
// Run: node examples/retries.ts (see examples/README.md)

import { Client, type RetryFunction, type RetryStrategy } from "lkrequest";

// Wait 200 ms, then twice as long, up to two retries.
const exponential: RetryStrategy = { strategy: "exponential", maxRetries: 2, baseDelay: 200 };

// Or wait the same time between retries.
const fixed: RetryStrategy = { strategy: "fixed", maxRetries: 2, interval: 300 };

// Or decide yourself. Return the delay in milliseconds before the next attempt, or `null` to
// give up. `status` is set when the server answered, `error` when the attempt failed.
const custom: RetryFunction = ({ attempt, status, error }) => {
  console.log(`  retry ${attempt}:`, status ?? error?.code);
  return attempt <= 2 ? 100 : null;
};

const client = new Client();

// httpbin answers this URL with 503 every time, so each session retries and then gives up. The
// last response is returned: running out of retries is not an error.
for (const [name, retry] of Object.entries({ exponential, fixed, custom })) {
  const session = client.session({ retry });
  const started = Date.now();
  const res = await session.get("https://httpbin.org/status/503");
  console.log(`${name}: ${res.status} after ${Date.now() - started} ms`);
}
