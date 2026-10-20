// HTTP/2 and HTTP/3
//
// Choose the HTTP version of a session, and see which one a request used.
//
// Run: node examples/http3-and-protocols.ts (see examples/README.md)

import { Client } from "lkrequest";

// Chrome presets carry a QUIC fingerprint, so they can speak HTTP/3. A client without a preset
// does not.
const client = new Client({ preset: "chrome_155" });
const url = "https://www.cloudflare.com/cdn-cgi/trace";

// `preferredHttpVersion` also takes "auto" (the default) and "http3_with_fallback", which tries
// HTTP/3 first and falls back to TCP.
for (const preferredHttpVersion of ["http1_only", "http2_only", "http3_only"] as const) {
  const res = await client.session({ preferredHttpVersion }).get(url);
  console.log(preferredHttpVersion.padEnd(10), res.httpVersion);
}

// A protocol policy decides more: whether to race TCP against QUIC, when to move a route to
// HTTP/3, and whether a failed HTTP/3 attempt may fall back. Start from a preset and change
// the parts you care about.
const strict = client.session({
  protocolPolicy: { preset: "chrome_standard", fallback: "no_fallback" },
});
console.log("policy".padEnd(10), (await strict.get(url)).httpVersion);
