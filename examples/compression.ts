// Compression
//
// Responses are decompressed for you. You can also choose which codings the client offers, or
// turn decoding off.
//
// Run: node examples/compression.ts (see examples/README.md)

import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

// gzip, deflate, Brotli and zstd are decoded without you doing anything.
const decoded = await session.get("/gzip");
console.log(
  decoded.headers.get("content-encoding"),
  (await decoded.json<{ gzipped: boolean }>()).gzipped,
);

// With `decompress: false` you get the bytes as the server sent them. A gzip stream starts
// with 0x1f 0x8b.
const raw = await session.get("/gzip", { decompress: false });
const bytes = await raw.bytes();
const start = Array.from(bytes.subarray(0, 2), (byte) => byte.toString(16));
console.log(bytes.byteLength, "bytes, starting with", start); // [ '1f', '8b' ]

// `Accept-Encoding` tells the server what the client can decode. Offer less, if you like. The
// same option works for a whole session.
const gzipOnly = await session.get("/headers", { acceptEncoding: ["gzip"] });
const { headers } = await gzipOnly.json<{ headers: Record<string, string> }>();
console.log(headers["Accept-Encoding"]);
