// WebSocket
//
// A WebSocket opened through a session keeps the session's fingerprint, cookies and proxy.
// This example talks to a public echo server, which sends back what it receives.
//
// Run: node examples/websocket.ts (see examples/README.md)

import { Client } from "lkrequest";

const session = new Client().session();
const ws = await session.websocket("wss://echo.websocket.org");

// A string is sent as a text message, bytes as a binary one.
await ws.send("hello");

// Messages arrive one at a time, and `type` says what kind. Some echo servers greet first, so
// read until our own message comes back.
for await (const message of ws) {
  if (message.type === "text") {
    console.log("received:", message.data);
    if (message.data === "hello") {
      break;
    }
  }
}

await ws.close();
