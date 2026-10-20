// Reading responses
//
// What a response tells you, and the ways to read its body. The response follows the Fetch
// standard: the same properties and body methods, and a body can be read only once.
//
// Run: node examples/reading-responses.ts (see examples/README.md)

import { Client } from "lkrequest";

const client = new Client();

const res = await client.get("https://httpbin.org/json");

// The status line, and the headers (a standard `Headers` object).
console.log(res.status, res.statusText, res.ok);
console.log(res.headers.get("content-type"));

// Beyond fetch: the protocol version, and the time the request took in milliseconds.
console.log(res.httpVersion, `${Math.round(res.elapsed)} ms`);

// The body: parsed JSON (the type argument is your claim about its shape)...
const json = await res.json<{ slideshow: { title: string } }>();
console.log(json.slideshow.title);

// ...text...
const robots = await client.get("https://httpbin.org/robots.txt");
console.log(await robots.text());

// ...or raw bytes.
const bytes = await (await client.get("https://httpbin.org/bytes/8")).bytes();
console.log(bytes.byteLength, "bytes");

// An error status is not an exception. Check `ok`, or call `throwForStatus()`
// (see error-handling.ts).
const missing = await client.get("https://httpbin.org/status/404");
console.log(missing.status, missing.ok); // 404 false
