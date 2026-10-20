// Middleware and hooks
//
// Middleware changes requests on their way out and responses on their way back. Hooks only
// watch.
//
// Run: node examples/middleware-and-hooks.ts (see examples/README.md)

import { Client, type Middleware } from "lkrequest";

// Middleware gets the request before it is sent and the response before you see it. Change
// what it receives in place, or return a replacement.
const traceId: Middleware = {
  name: "trace-id",
  onRequest(request) {
    request.headers.push(["x-trace-id", "demo-1"]);
  },
  onResponse(response) {
    console.log("middleware: the response is", response.status);
  },
};

// A client's middleware runs for all of its sessions.
const client = new Client({ middleware: [traceId] });

// Hooks are told about each request and response, and cannot change them.
const session = client.session({
  baseUrl: "https://httpbin.org",
  onRequest: (event) => console.log("hook: sending", event.method, event.url),
  onResponse: (event) =>
    console.log("hook: got", event.status, `in ${Math.round(event.elapsed)} ms`),
});

// More hooks can be added later. Each call returns a function that removes the hook.
const removeHook = session.onResponse(() => console.log("hook: a second one"));

const res = await session.get("/headers");
const { headers } = await res.json<{ headers: Record<string, string> }>();
console.log("the server saw x-trace-id:", headers["X-Trace-Id"]);

removeHook();
