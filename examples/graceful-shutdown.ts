// Graceful shutdown
//
// Before a process or a worker exits, wait for the requests still in flight to finish.
//
// Run: node examples/graceful-shutdown.ts (see examples/README.md)

import { setTimeout as sleep } from "node:timers/promises";
import { Client, drainPending, pendingRequests } from "lkrequest";

const session = new Client().session();

// Three slow requests, started and not awaited.
const requests = [1, 2, 3].map((seconds) => session.get(`https://httpbin.org/delay/${seconds}`));
await sleep(200); // give them a moment to reach the native layer
console.log("pending:", pendingRequests()); // 3

// This is what a SIGTERM handler would do: wait for what is in flight, for at most ten seconds.
// `false` means the time ran out first.
const drained = await drainPending({ timeout: 10_000 });
console.log("drained:", drained, "pending:", pendingRequests()); // drained: true pending: 0

console.log((await Promise.all(requests)).map((res) => res.status));
