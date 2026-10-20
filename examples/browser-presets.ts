// Browser presets
//
// A preset makes the client look like a real browser: its TLS handshake, HTTP/2 settings, TCP
// behavior and header order. A `ClientPool` hands out several of them in turn.
//
// Run: node examples/browser-presets.ts (see examples/README.md)

import { Client, ClientPool, listPresets } from "lkrequest";

// The presets this build knows.
const names = listPresets().map((preset) => preset.name);
console.log(names.join(" "));

// A preset sets the fingerprint, not the header values: send the ones the browser would.
const chrome = new Client({
  preset: "chrome_155",
  defaultHeaders: {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
  },
});
console.log(chrome.fingerprintInfo()); // the TLS profile, HTTP/2 settings and TCP fingerprint

// What the server received.
const res = await chrome.get("https://httpbin.org/headers");
console.log(await res.json());

// A pool hands out its clients in turn, so traffic does not carry one fingerprint throughout.
const pool = new ClientPool([
  chrome,
  new Client({ preset: "firefox_156" }),
  new Client({ preset: "safari_26" }),
]);
for (let i = 0; i < 3; i++) {
  console.log(pool.acquire().fingerprintInfo().tlsProfile);
}
