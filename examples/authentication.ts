// Authentication
//
// Send credentials with the `auth` option: a bearer token, or a user name and password for
// basic authentication. Both go into the `Authorization` header.
//
// Run: node examples/authentication.ts (see examples/README.md)

import { Client } from "lkrequest";

const client = new Client();

// A bearer token.
const bearer = await client.get("https://httpbin.org/bearer", { auth: { bearer: "my-token" } });
console.log("bearer:", bearer.status, await bearer.json());

// A user name and password. httpbin accepts the pair that is part of the URL.
const basic = await client.get("https://httpbin.org/basic-auth/user/pw", {
  auth: { username: "user", password: "pw" },
});
console.log("basic:", basic.status, await basic.json());

// Wrong credentials are an error status, not an exception.
const wrong = await client.get("https://httpbin.org/basic-auth/user/pw", {
  auth: { username: "user", password: "no" },
});
console.log("wrong:", wrong.status); // 401

// To authenticate every request, put the header in the client's `defaultHeaders` instead.
const always = new Client({ defaultHeaders: { authorization: "Bearer my-token" } });
console.log("default header:", (await always.get("https://httpbin.org/bearer")).status);
