// Proxy pool
//
// A pool hands out proxies in turn and sets aside the ones that keep failing. This example only
// leases proxies and never connects to them, so no proxy has to be running.
//
// Run: node examples/proxy-pool.ts (see examples/README.md)

import { ProxyConfig, ProxyPool } from "lkrequest";

const pool = new ProxyPool(
  ["http://127.0.0.1:8081", "http://127.0.0.1:8082", "http://127.0.0.1:8083"],
  {
    rotation: "round_robin",
    // A proxy reported twice within a minute is set aside for five minutes.
    badProxy: { failureThreshold: 2, window: 60_000, cooldown: 300_000 },
  },
);

// Lease a proxy, use it, give it back.
for (let i = 0; i < 4; i++) {
  const lease = await pool.acquire();
  console.log(i, lease.proxy?.toString()); // use `client.session({ proxy: lease.proxy })` here
  lease.release();
}

// When a request through a proxy fails, report it with `lease.markBad()`. `acquireFresh()` does
// that for the lease it is given, releases it, and leases the next proxy.
const failed = await pool.acquire();
const next = await pool.acquireFresh(failed);
console.log("failed:", failed.proxy?.toString(), "next:", next.proxy?.toString());
next.release();

// While every proxy is set aside, `acquire()` waits for one to come back; a signal ends the wait.
const lone = new ProxyPool(["http://127.0.0.1:8084"], { badProxy: { failureThreshold: 1 } });
lone.markBad(ProxyConfig.parse("http://127.0.0.1:8084").identity);
try {
  await lone.acquire({ signal: AbortSignal.timeout(500) });
} catch (error) {
  console.log("gave up waiting:", (error as Error).name); // AbortError
}

// Or make the proxies up as they are needed, for example a gateway that wants a new session
// name for each connection.
let count = 0;
const gateway = new ProxyPool(() =>
  ProxyConfig.parse("http://127.0.0.1:7777").withUserPass(`session-${++count}`, "pw"),
);
for (let i = 0; i < 2; i++) {
  const lease = await gateway.acquire();
  console.log(lease.proxy?.identity);
  lease.release();
}
