// Uploads
//
// Send a file as multipart form data, or stream a body that is too big to hold in memory.
//
// Run: node examples/uploads.ts (see examples/README.md)

import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

// Multipart form data is a standard `FormData`. A `Blob` with a file name stands in for a file.
const form = new FormData();
form.append("title", "hello");
form.append("file", new Blob(["file contents"], { type: "text/plain" }), "hello.txt");

const uploaded = await session.post("/post", { body: form });
const echo = await uploaded.json<{ form: object; files: object }>();
console.log(echo.form, echo.files);

// A streamed body is any async iterable of strings or bytes: a generator, a `Readable` such as
// `fs.createReadStream()`, a `ReadableStream`. It is pulled only as fast as the connection can
// send it. If you know the size, pass `contentLength` to avoid chunked framing on HTTP/1.1.
async function* lines(): AsyncGenerator<string> {
  for (let n = 1; n <= 3; n++) {
    yield `line ${n}\n`;
  }
}

const streamed = await session.post("/post", {
  body: lines(),
  headers: { "content-type": "text/plain" },
});
console.log((await streamed.json<{ data: string }>()).data);
