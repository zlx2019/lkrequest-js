# Examples

Short programs that use lkrequest the way an application would. They are listed from the
simplest to the most involved, and each one assumes the ones before it.

## Running

Build the package, then run an example from the repository root with Node.js 22.18 or later,
which runs TypeScript directly:

```bash
pnpm install
pnpm build
node examples/simple-request.ts
```

Node.js 22.12 to 22.17 need type stripping turned on:
`node --experimental-strip-types examples/simple-request.ts`.

The examples send requests to [httpbin.org](https://httpbin.org), which echoes what it
receives, so they need network access. They import from `"lkrequest"`, as your own code would.
Two of them need something more, as their descriptions say.

## The examples

**The basics**

| Example | Shows |
|---|---|
| [simple-request.ts](simple-request.ts) | A client, one GET, the response |
| [request-methods.ts](request-methods.ts) | The methods; query parameters, headers, JSON, form and text bodies |
| [authentication.ts](authentication.ts) | Bearer and basic authentication |
| [reading-responses.ts](reading-responses.ts) | Status, headers, and reading the body as JSON, text or bytes |
| [error-handling.ts](error-handling.ts) | Error statuses against failed requests, the error classes, cancelling |
| [cookies.ts](cookies.ts) | The cookie jar of a session |

**Configuring the client**

| Example | Shows |
|---|---|
| [browser-presets.ts](browser-presets.ts) | Browser presets, default headers, rotating fingerprints with `ClientPool` |
| [timeouts-and-redirects.ts](timeouts-and-redirects.ts) | Phase timeouts; following, stopping and limiting redirects |
| [retries.ts](retries.ts) | The built-in retry strategies and a retry function of your own |
| [compression.ts](compression.ts) | Decoded bodies, the raw bytes, which codings to offer |
| [middleware-and-hooks.ts](middleware-and-hooks.ts) | Changing requests and responses; watching them with hooks |

**Moving data**

| Example | Shows |
|---|---|
| [uploads.ts](uploads.ts) | Multipart form data and streamed request bodies |
| [streaming-downloads.ts](streaming-downloads.ts) | Reading a large response as a stream |
| [websocket.ts](websocket.ts) | A WebSocket connection (talks to a public echo server) |

**The network**

| Example | Shows |
|---|---|
| [proxies.ts](proxies.ts) | HTTP and SOCKS5 proxies, credentials, chains, health checks (needs a proxy of your own) |
| [proxy-pool.ts](proxy-pool.ts) | Leasing proxies in turn, reporting bad ones, giving up a wait, making proxies up on demand |
| [session-pool.ts](session-pool.ts) | Leasing sessions and giving them back |
| [dns-and-network.ts](dns-and-network.ts) | DNS servers, DNS over HTTPS, your own resolver, the address family, pinned addresses |
| [http3-and-protocols.ts](http3-and-protocols.ts) | Choosing HTTP/1.1, HTTP/2 or HTTP/3; protocol policies |
| [connection-prewarming.ts](connection-prewarming.ts) | Opening connections ahead of the first request |

**TLS and security**

| Example | Shows |
|---|---|
| [tls-options.ts](tls-options.ts) | Certificate checks, relaxing them, writing out TLS secrets for Wireshark |
| [hsts.ts](hsts.ts) | Upgrading http:// to https:// with HSTS policies, and refusing http:// |

**Going further**

| Example | Shows |
|---|---|
| [custom-fingerprint.ts](custom-fingerprint.ts) | Mixing and building the TLS, HTTP/2 and TCP layers; randomizing |
| [diagnostics.ts](diagnostics.ts) | Phase timings of a response; tracing events on `node:diagnostics_channel` |
| [metrics.ts](metrics.ts) | Request counters per host, Prometheus text, the transport counters of the Rust library |
| [logging.ts](logging.ts) | Log events of the Rust library: levels, targets, a listener of your own |
| [graceful-shutdown.ts](graceful-shutdown.ts) | Waiting for requests in flight before exiting |
