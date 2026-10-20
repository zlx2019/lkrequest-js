// Streaming downloads
//
// `session.stream()` resolves as soon as the response headers arrive. The body is then read as
// you pull it, so a large download never sits in memory.
//
// Run: node examples/streaming-downloads.ts (see examples/README.md)

import { Client } from "lkrequest";

const session = new Client().session();

const res = await session.stream("https://httpbin.org/stream-bytes/102400?chunk_size=10240");
console.log(res.status, res.headers.get("content-type"));

// `body` is a `ReadableStream` of bytes, the same kind `fetch` gives you.
let bytes = 0;
let chunks = 0;
for await (const chunk of res.body) {
  bytes += chunk.byteLength;
  chunks++;
}
console.log(`${bytes} bytes in ${chunks} chunks`);

// The usual body methods work too; they read whatever is left.
const robots = await session.stream("https://httpbin.org/robots.txt");
console.log(await robots.text());
