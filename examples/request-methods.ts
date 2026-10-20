// Request methods
//
// The methods, and the options you reach for most: query parameters, headers, and JSON, form
// and text bodies.
//
// Run: node examples/request-methods.ts (see examples/README.md)

import { Client } from "lkrequest";

const client = new Client();

// A session keeps cookies and connections between requests. With a `baseUrl`, the requests
// below can use short paths.
const session = client.session({ baseUrl: "https://httpbin.org" });

// GET, with query parameters and a header.
const got = await session.get("/get", {
  params: { q: "lkrequest" },
  headers: { "x-demo": "1" },
});
console.log("GET   ", got.status, (await got.json<{ args: object }>()).args);

// POST a JSON body. The content type is set for you.
const posted = await session.post("/post", { json: { hello: "world" } });
console.log("POST  ", posted.status, (await posted.json<{ json: object }>()).json);

// PUT a form (application/x-www-form-urlencoded).
const put = await session.put("/put", { body: new URLSearchParams({ name: "lkrequest" }) });
console.log("PUT   ", put.status, (await put.json<{ form: object }>()).form);

// PATCH a text body.
const patched = await session.patch("/patch", { body: "plain text" });
console.log("PATCH ", patched.status, (await patched.json<{ data: string }>()).data);

// DELETE and HEAD have no body to send.
console.log("DELETE", (await session.delete("/delete")).status);
console.log("HEAD  ", (await session.head("/get")).status);
