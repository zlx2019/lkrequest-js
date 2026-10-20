// Simple request
//
// The shortest program: one client, one GET, the response. A client built without options
// already uses a Chrome 155 TLS and HTTP/2 fingerprint.
//
// Run: node examples/simple-request.ts (see examples/README.md)

import { Client } from "lkrequest";

const client = new Client();

// `client.get()` sends one request with a session of its own and closes it afterwards.
const res = await client.get("https://httpbin.org/get");

console.log(res.status, res.statusText); // 200 OK
console.log(res.httpVersion); // 2.0, what was negotiated with the server
console.log(await res.json());
