<h1 align="center">lkrequest</h1>

<p align="center">
  <strong>A Node.js HTTP client with byte-level TLS, HTTP/2 and HTTP/3 fingerprint control, powered by Rust.</strong>
</p>

<p align="center">
  Browser presets · Proxies and pools · WebSocket · HTTP/3 · A fetch-style API
</p>

<p align="center">
  <a href="https://github.com/EZXLabs/lkrequest-js/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/EZXLabs/lkrequest-js/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/lkrequest"><img alt="npm version" src="https://img.shields.io/npm/v/lkrequest?style=flat-square&logo=npm&logoColor=white"></a>
  <a href="https://www.npmjs.com/package/lkrequest"><img alt="npm downloads" src="https://img.shields.io/npm/dm/lkrequest?style=flat-square&label=downloads"></a>
  <img alt="Node.js 22.12 or later" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="TypeScript types included" src="https://img.shields.io/badge/types-included-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Powered by Rust" src="https://img.shields.io/badge/powered%20by-Rust-CE422B?style=flat-square&logo=rust&logoColor=white">
  <img alt="Platforms: Linux, macOS and Windows" src="https://img.shields.io/badge/platform-linux%20%7C%20macos%20%7C%20windows-lightgrey?style=flat-square">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#guides">Guides</a> ·
  <a href="examples/README.md">Examples</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

lkrequest lets you decide what a request looks like on the wire. It reproduces the TLS handshake,
HTTP/2 settings, HTTP/3 and QUIC parameters and TCP options of a real browser, or sends a
fingerprint you build yourself, behind a `fetch`-style API with sessions, cookies, proxies,
WebSocket and typed errors.

## Highlights

- **Browser presets** — Chrome 131 and 144–155, Firefox 133/147/156, and Safari 18/26. Each sets the
  TLS handshake, the HTTP/2 settings and the TCP fingerprint together, and the Chrome presets add
  HTTP/3 and QUIC.
- **Programmable fingerprints** — Build TLS, HTTP/2 and TCP fingerprints by hand, from JSON or from
  captured traffic, check that the layers belong together, and shuffle the TLS extension order on
  every connection.
- **HTTP/1.1, HTTP/2 and HTTP/3** — Choose the version per session or per request, or let a
  protocol policy decide when to race TCP against QUIC and when to fall back.
- **Proxies** — HTTP CONNECT, SOCKS5, SOCKS5h, multi-hop chains and MASQUE (experimental), with
  proxy pools, health checks and credentials computed for every connection.
- **A familiar API** — `fetch`-style responses and request bodies (`FormData`, `URLSearchParams`,
  `Blob`, streams with backpressure), `AbortSignal`, and typed errors that carry a code, the phase
  that failed and a retry hint.
- **Sessions** — An isolated cookie jar in the Playwright and Puppeteer format, connection pooling,
  redirect control, retries, middleware, hooks and HSTS.
- **WebSocket** — `wss://` connections that keep the session's fingerprint, cookies and proxy.
- **Network control** — System, cached, public and DNS-over-HTTPS resolvers, or a function of your
  own; IPv4-only or IPv6-only connections; pinned addresses.
- **Observability** — Phase timings on every response, `node:diagnostics_channel` events,
  Prometheus-format counters, log events, and TLS key logs for Wireshark.
- **Simple to install** — Prebuilt binaries for Linux, macOS and Windows on x64 and arm64, so no
  Rust toolchain or compiler is needed. TypeScript types are included.

## Installation

```bash
npm install lkrequest
# or: pnpm add lkrequest · yarn add lkrequest
```

lkrequest needs **Node.js 22.12 or later**. It is an ES module package, and CommonJS code can load
it with `import()` or `require()`.

The native addon comes as a prebuilt package per platform (`@lkrequest/binding-*`), and your
package manager installs the one that matches your system: **Linux** (glibc 2.28 or later, and
musl such as Alpine), **macOS** and **Windows**, each on x64 and arm64.

## Quick start

```ts
import { Client } from "lkrequest";

// A client carries the fingerprint and the connection settings.
const client = new Client({ preset: "chrome_155" });

// A session carries cookies and connections, shared by its requests.
const session = client.session({ baseUrl: "https://httpbin.org" });

const res = await session.get("/get", { params: { q: "lkrequest" } });
console.log(res.status, res.httpVersion); // 200 2.0
console.log(await res.json());
```

For a single request, `client.get(url)` opens a session of its own and closes it afterwards.
Without a `preset`, a client uses the default fingerprint: Chrome 155 TLS and HTTP/2, with
HTTP/3 off.

## Guides

### Browser fingerprints

A preset makes the client look like a real browser at the protocol level: it sets the TLS
handshake, the HTTP/2 settings and the TCP fingerprint, and the Chrome presets set the HTTP/3 and
QUIC parameters too. `listPresets()` lists every preset your build has.

```ts
import { Client, listPresets } from "lkrequest";

// Every preset this build knows: { name: "chrome_155", browser: "chrome", http3: true }, ...
console.log(listPresets());

const client = new Client({
  preset: "chrome_155",
  // A preset sets the fingerprint, not header values. Send the ones the browser would.
  defaultHeaders: {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
  },
});

// Ask a fingerprint echo service what it saw. Any service that reports JA3 or JA4 will do.
const res = await client.get("https://tls.peet.ws/api/clean");
const seen = await res.json<{ ja4: string; akamai_hash: string }>();
console.log(seen.ja4, seen.akamai_hash); // the TLS (JA4) and HTTP/2 (Akamai) fingerprints
```

A `ClientPool` hands out several clients in turn, so traffic does not carry a single fingerprint:

```ts
import { Client, ClientPool } from "lkrequest";

const pool = new ClientPool([
  new Client({ preset: "chrome_155" }),
  new Client({ preset: "firefox_156" }),
  new Client({ preset: "safari_26" }),
]);

const res = await pool.acquire().get("https://httpbin.org/get");
console.log(res.status);
```

### Requests and responses

Request bodies and responses follow the Fetch standard. `body` takes a string, binary data, a
`Blob`, `URLSearchParams`, `FormData` or a stream, and `json` serializes a value for you.

```ts
import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

const res = await session.post("/post", {
  params: { source: "readme" }, // the query string: ?source=readme
  headers: { "x-demo": "1" }, // a list of pairs, [["x-demo", "1"]], keeps the order you give
  json: { hello: "world" }, // sent as application/json
});

console.log(res.status, res.ok, res.httpVersion); // 200 true 2.0
console.log(await res.json()); // text(), bytes(), blob(), arrayBuffer() and body work too
```

`get`, `post`, `put`, `patch`, `delete`, `head` and `options` exist on both clients and sessions.

### Cookies

Every session has its own cookie jar, in the format Playwright and Puppeteer use.

```ts
import { Client } from "lkrequest";

const session = new Client().session({ baseUrl: "https://httpbin.org" });

// Cookies the server sets are stored, and sent back to the URLs they match.
await session.get("/cookies/set", { params: { theme: "dark" } });
console.log(session.cookies.getAll()); // [{ name: "theme", value: "dark", domain: "httpbin.org", ... }]

// Add one yourself, or send one for a single request only.
session.cookies.set("https://httpbin.org", { name: "token", value: "abc", httpOnly: true });
await session.get("/cookies", { cookies: { extra: "1" } });
```

### Proxies

A proxy is a URL. `http://` opens a tunnel with CONNECT, `socks5://` resolves the target's name on
your side, and `socks5h://` leaves that to the proxy. The addresses below stand in for your own
proxies.

```ts
import { Client, ProxyConfig, SessionPool } from "lkrequest";

const client = new Client({ preset: "chrome_155" });

// Every request of the session goes through its proxy.
const session = client.session({ proxy: "socks5h://127.0.0.1:1080" });
const res = await session.get("https://httpbin.org/ip");
console.log(await res.json()); // the proxy's address, not yours

// Credentials go onto a ProxyConfig (or into the URL). A chain connects through each hop in turn.
const withLogin = ProxyConfig.parse("http://127.0.0.1:8080").withUserPass("user", "pass");
const chain = ProxyConfig.chain(["http://127.0.0.1:8080", "socks5://127.0.0.1:1080"]);
await client.session({ proxy: withLogin }).get("https://httpbin.org/ip");
await client.session({ proxy: chain }).get("https://httpbin.org/ip");

// A single request can use another proxy than its session's.
await session.get("https://httpbin.org/ip", { proxy: "http://127.0.0.1:8081" });

// A pool leases out sessions, each bound to one of its proxies.
const pool = new SessionPool(client, {
  proxies: ["http://127.0.0.1:8081", "http://127.0.0.1:8082"],
});
const lease = await pool.acquire();
try {
  console.log((await lease.session.get("https://httpbin.org/ip")).status);
} finally {
  lease.release(); // always give the session back
}
```

If a request failed because of its proxy, call `lease.markBad()` before you release the lease: the
session is discarded, and the failure counts against that proxy. Leases also work with `using`,
where your toolchain supports it. `ProxyConfig#healthCheck()` opens a tunnel and reports how long
it took, `ProxyPool` leases bare proxies, and `masque://` proxies tunnel HTTP/3 over CONNECT-UDP
(experimental). See [`proxies.ts`](examples/proxies.ts), [`proxy-pool.ts`](examples/proxy-pool.ts)
and [`session-pool.ts`](examples/session-pool.ts).

### WebSocket

A WebSocket opened through a session keeps the session's fingerprint, cookies and proxy.

```ts
import { Client } from "lkrequest";

const session = new Client({ preset: "chrome_155" }).session();
const ws = await session.websocket("wss://echo.websocket.org");

await ws.send("hello"); // a string is a text message, bytes are a binary one

// Iterating yields every message, and ends after the peer's close message.
for await (const message of ws) {
  if (message.type === "text") {
    console.log("received:", message.data);
    if (message.data === "hello") break; // the echo server greets first
  }
}

await ws.close();
```

You can also call `ws.receive()` one message at a time, and `ws.ping()`.

### Streaming

`session.stream()` resolves as soon as the response headers arrive, and the body is pulled from
the network as you read it. Request bodies can be streams too, and are pulled only as fast as the
connection can send them.

```ts
import { createReadStream } from "node:fs";
import { Client } from "lkrequest";

const session = new Client().session();

// Download: a large body never sits in memory.
const download = await session.stream("https://httpbin.org/stream-bytes/102400");
let size = 0;
for await (const chunk of download.body) size += chunk.byteLength;
console.log(size, "bytes");

// Upload: any Readable, ReadableStream or async iterable works (a file of your own here).
await session.put("https://httpbin.org/put", { body: createReadStream("./big.bin") });

// Multipart form data is a standard FormData, with a Chrome-style boundary.
const form = new FormData();
form.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
await session.post("https://httpbin.org/post", { body: form });
```

### HTTP/3

The Chrome presets carry QUIC parameters. `preferredHttpVersion` picks the protocol of a session,
or of a single request: `"auto"`, `"http1_only"`, `"http2_only"`, `"http3_only"` or
`"http3_with_fallback"`.

```ts
import { Client } from "lkrequest";

const client = new Client({ preset: "chrome_155" });
const session = client.session({ preferredHttpVersion: "http3_only" });

const res = await session.get("https://www.cloudflare.com/cdn-cgi/trace");
console.log(res.httpVersion); // 3.0
```

For finer control, such as racing TCP against QUIC or whether a failed HTTP/3 attempt may fall
back, start from a protocol policy and change the parts you care about:
`client.session({ protocolPolicy: { preset: "chrome_standard", fallback: "no_fallback" } })`.

### Retries, timeouts and redirects

Limit each phase of a request, retry failures and statuses such as 429 and 503, and decide what a
redirect does.

```ts
import { Client } from "lkrequest";

const client = new Client({
  // Limits per phase, in milliseconds. `total` covers the whole request, redirects included.
  timeouts: { tcpConnect: 5_000, tlsHandshake: 5_000, ttfb: 10_000, total: 30_000 },
});

const session = client.session({
  retry: { strategy: "exponential", maxRetries: 3, baseDelay: 200 }, // or "fixed", or a function
  redirect: "follow", // "manual" returns the redirect response, "error" refuses to follow one
  maxRedirects: 5,
});

console.log((await session.get("https://httpbin.org/redirect/2")).url);
```

A retry function gets `{ attempt, status, error }` and returns the delay in milliseconds before the
next attempt, or `null` to stop. Requests that are not safe to repeat, such as a POST the server
may have processed or a streamed body, are not retried whatever it returns.

### Middleware and hooks

Middleware changes requests on their way out and responses on their way back. Hooks only watch.

```ts
import { Client, type Middleware } from "lkrequest";

const auth: Middleware = {
  name: "auth",
  onRequest(request) {
    request.headers.push(["authorization", "Bearer my-token"]);
  },
};

// A client's middleware runs for all of its sessions.
const client = new Client({ middleware: [auth] });

const session = client.session({
  onResponse: (event) => console.log(event.status, `${Math.round(event.elapsed)} ms`),
});
const res = await session.get("https://httpbin.org/bearer");
console.log(await res.json()); // { authenticated: true, token: "my-token" }
```

### Error handling

A request that fails rejects with a subclass of `RequestError`. A response with an error status
does not: check `res.ok`, or call `res.throwForStatus()`.

```ts
import { Client, HttpStatusError, RequestError, TimeoutError } from "lkrequest";

const client = new Client();

try {
  const res = await client.get("https://httpbin.org/delay/5", { timeout: 1_000 });
  res.throwForStatus();
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log(error.code, error.retryable); // ERR_LK_TIMEOUT true
  } else if (error instanceof HttpStatusError) {
    console.log(error.status);
  } else if (error instanceof RequestError) {
    console.log(error.code, error.message);
  } else {
    throw error;
  }
}
```

`AbortSignal` works as it does for `fetch`: `client.get(url, { signal: AbortSignal.timeout(5_000) })`.

### DNS, TLS and HSTS

Choose how names are resolved, which address family is used, and what happens to a plain
`http://` URL.

```ts
import { Client, Hsts } from "lkrequest";

const client = new Client({
  dns: "cloudflare", // or { server: "1.1.1.1" }, "google_https" (DNS over HTTPS), or { resolve }
  family: 4, // connect over IPv4 only; 6 is IPv6 only, 0 is either
});

// Upgrade http:// to https:// as a browser does after HSTS, and refuse plain http:// altogether.
const session = client.session({ hsts: Hsts.dynamic(["httpbin.org"]), httpsOnly: true });
const res = await session.get("http://httpbin.org/get");
console.log(res.url); // https://httpbin.org/get
```

Other options of `Client` follow the same pattern. `connectTo` dials a fixed address for a host
while the TLS server name, the `Host` header and the certificate check keep the name.
`tls: { ca }` trusts a private certificate authority, `tls: { rejectUnauthorized: false }` turns
certificate checks off (for testing only), and `tls: { keylog: "./keys.log" }` writes the TLS
secrets in the NSS key log format, for Wireshark.

### Custom fingerprints

Each layer can come from a preset, from JSON, from captured traffic or from your own values. Mix
them freely, then check that they still belong together.

```ts
import {
  Client,
  H2Profile,
  TcpFingerprint,
  TlsProfile,
  validateFingerprintConsistency,
} from "lkrequest";

const client = new Client({
  tlsProfile: TlsProfile.preset("chrome_155"), // or fromJSON(), fromClientHello(bytes), create()
  h2Profile: H2Profile.preset("chrome_155"), // or fromJSON(), fromH2Frames(bytes), create()
  tcpFingerprint: TcpFingerprint.fromJa4t("64240_2-1-3-1-1-4_1460_8"), // or create()
});
console.log(client.fingerprintInfo());

// A Chrome handshake with Firefox's HTTP/2 settings is easy to spot.
const check = validateFingerprintConsistency({
  tlsProfile: "chrome_155",
  h2Profile: "firefox_156",
});
console.log(check.valid, check.warnings); // false [ "TLS profile family 'chrome' does not match ..." ]
```

The option `randomize: "extension_order"` shuffles the TLS extension order on every connection. The
JA3 changes, the JA4 stays the same, and the client remains a plausible browser. Chrome presets
already shuffle, as Chrome does; Firefox presets do not, so this is where it helps. The modes
`"recombine"` and `"full"` (written `randomize: { mode: "recombine" }`) go further and synthesize a
fingerprint that matches no real browser, for targets that block the known ones.

### Observability

Four ways to see what the client does: log events, tracing events, counters, and the timings of
each response.

```ts
import { subscribe } from "node:diagnostics_channel";
import { Client, enableMetrics, onLog, type RequestEndMessage, setLogLevel } from "lkrequest";

// Log events of the Rust library, with the syntax of `tracing` filters.
setLogLevel("lkrequest=debug");
onLog((record) => console.log(`[${record.level}] ${record.message}`));

// Tracing events for APM tools: lkrequest:request:start, :end and :error.
subscribe("lkrequest:request:end", (message) => {
  const { request, response } = message as RequestEndMessage;
  console.log(request.method, request.url, response.status);
});

// Counters per host, also as Prometheus text.
const metrics = enableMetrics();

const res = await new Client().get("https://httpbin.org/get");

// Every response says how long each phase took. A phase that did not run is missing.
console.log(res.diagnostics); // { dnsMs, tcpMs, tlsMs, ttfbMs, totalMs, remoteAddr, protocol, ... }
console.log(metrics.prometheusText());
```

`pendingRequests()` counts the requests in flight, and `await drainPending({ timeout })` waits for
them, for example in a SIGTERM handler before the process exits.

## How it works

```text
your code
   │  Client · Session · Response · ...         a fetch-style TypeScript API
   ▼
lkrequest (this package)
   │  Node-API, through napi-rs                 one prebuilt addon per platform
   ▼
native addon (Rust)
   │
   ▼
lkrequest-rs                                    TLS · HTTP/2 · HTTP/3 and QUIC
                                                proxies · DNS · cookies
```

Requests run on a Rust async runtime, so they do not block the Node.js event loop, and the bytes
of a response reach JavaScript without a copy. What goes on the wire comes from the Rust library,
so a new browser preset lands there first and reaches this package with the next release.

## Good to know

- **A preset sets fingerprints, not header values.** Send the `User-Agent`, `Accept-Language` and
  other headers the browser would send, and keep them consistent with the preset.
- **Only the Chrome presets speak HTTP/3.** Firefox and Safari presets carry no QUIC parameters and
  stay on TCP.
- **Functions you pass in run on the main thread.** A DNS resolver, a proxy function, custom proxy
  credentials, a custom HSTS policy or middleware runs there while its request waits, so keep them
  quick. For proxies made up per session, `proxyBuffer` prepares some ahead of time.
- **A pool waits for a usable proxy.** When all of its proxies are cooling down after failures, or
  its proxy function keeps failing, `acquire()` waits rather than hand out a direct connection.
  Pass a `signal` to stop waiting.
- **MASQUE is experimental.** Its API and behavior may change in any release.

## Development

Building from source needs Rust (stable), Node.js 22.12 or later, pnpm (through corepack), CMake
and NASM. The tests also need [uv](https://docs.astral.sh/uv/), which runs their local test
servers.

```bash
pnpm install
pnpm build:native:debug   # native addon, all features, debug profile
pnpm test                 # vitest
pnpm typecheck            # tsc --noEmit
pnpm lint                 # Biome + rustfmt + clippy
pnpm build                # release native addon + dist/
```

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the project layout, the code
style and the checklist for pull requests. What the client sends on the wire comes from the
[Rust library](https://github.com/EZXLabs/lkrequest-rs), so changes to fingerprints belong there.

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. The same file states
what the project is intended for.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
