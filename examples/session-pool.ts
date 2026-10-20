// Session pool
//
// A pool leases out sessions and takes them back when you are done. With `proxies`, each
// session is bound to one proxy; this example leaves them out, so its sessions connect directly.
//
// Run: node examples/session-pool.ts (see examples/README.md)

import { Client, SessionPool } from "lkrequest";

const client = new Client({ preset: "chrome_155" });

// Add `proxies: ["http://127.0.0.1:8081", ...]` to bind each session to a proxy.
const pool = new SessionPool(client, { maxSessions: 2 });

// Lease a session, use it, and always give it back, even when the request fails.
const lease = await pool.acquire();
try {
  const res = await lease.session.get("https://httpbin.org/get");
  console.log(res.status);
} finally {
  lease.release();
}
console.log(await pool.stats()); // how many sessions are idle, and the limit

// If a request failed because of the session's proxy, report it with `lease.markBad()`: the
// session is dropped instead of being used again. `acquireFresh()` does that for the lease it
// is given, and leases another session.
const failed = await pool.acquire();
const fresh = await pool.acquireFresh(failed);
try {
  console.log((await fresh.session.get("https://httpbin.org/get")).status);
} finally {
  fresh.release();
}
