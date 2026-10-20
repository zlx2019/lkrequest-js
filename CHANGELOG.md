# Changelog

All notable changes to this project are documented in this file.

## lkrequest-js 0.1.0

The first release of lkrequest-js, the Node.js binding of lkrequest 0.2.4, a Rust HTTP client.
It reproduces the TLS handshake, HTTP/2 settings, HTTP/3 and QUIC parameters and TCP options of
a real browser, or sends a fingerprint you build yourself, behind a `fetch`-style API with
sessions, cookies, proxies, WebSocket and typed errors. Requests run on a Rust async runtime, so
they do not block the event loop. It needs Node.js 22.12 or later and is an ES module package
that CommonJS code can load with `import()` or `require()`. TypeScript types are included, and
prebuilt addons cover Linux (glibc 2.28 or later, and musl), macOS and Windows, on x64 and arm64.

### 🚀 Features

- **Browser Presets** — `preset` takes one of 18 browser fingerprints: Chrome 131 and 144–155,
  Firefox 133, 147 and 156, and Safari 18 and 26. Each sets the TLS handshake, the HTTP/2
  settings and the TCP fingerprint together, and the Chrome presets add HTTP/3 and QUIC;
  `listPresets()` names them. A client without a preset presents Chrome 155's TLS and HTTP/2,
  with HTTP/3 off. `features()` and `version` report the compiled capabilities and the version.
- **Clients And Sessions** — A `Client` holds the fingerprint and the connection settings:
  default headers, header and cookie order, phase timeouts (`timeouts`), resource limits,
  HTTP/2 dispatch batching and fallbacks. Its sessions each keep their own cookies, connection
  pool, redirect mode (`follow`, `manual` or `error`, with `maxRedirects`), `baseUrl`, retries,
  middleware and hooks, and send `get`, `post`, `put`, `delete`, `head`, `patch`, `options` and
  `request`. `client.get()` and the other methods use a session of their own, closed afterwards.
  `preconnect()`, `preconnectMany()` and `prefetch()` open connections ahead of the requests;
  `poolStats()`, `clearPool()`, `close()` and `Symbol.dispose` manage them, and a request on a
  closed session fails with `ERR_LK_SESSION_CLOSED`.
- **Requests** — Headers keep the order you give them, and a name repeated among the pairs is
  sent once per value. The options cover `params`, `json`, `cookies`, `cookieOverride`, `auth`,
  `timeout`, `decompress` and `acceptEncoding` (gzip, Brotli, deflate and zstd), the RFC 9218
  `priority`, `h2PriorityWeight`, `idempotency`, a `proxy` for one request (refused when invalid
  rather than ignored), and `signal` to cancel with an `AbortSignal`. Bodies follow the Fetch
  standard: strings, binary data, `Blob`, `URLSearchParams`, `FormData` with a Chrome-style
  multipart boundary, and streams (`ReadableStream`, `Readable`, async iterables) pulled with
  backpressure.
- **Responses** — A `fetch`-style `Response` with `status`, `ok`, `headers` and `redirected`,
  zero-copy `bytes()`, `arrayBuffer()`, `blob()` and `body`, charset-aware `text()` and `json()`,
  and beyond fetch, `headerList` (duplicates kept), `httpVersion`, `cookies`, `history`,
  `diagnostics`, `elapsed` and `throwForStatus()`. `session.stream()` returns a
  `StreamingResponse` whose decompressed body is pulled from the network as you read it, and
  released when cancelled, disposed or garbage collected. A `deflate` body is decoded in zlib or
  raw form, and one cut short fails rather than coming back shorter.
- **Redirects** — A redirect filters the client's `defaultHeaders` as it filters the request's
  own headers: one to another origin drops a default `Authorization`, `Cookie` or `Host`, one
  from https to http a default `Referer`, and one that turns a POST into a GET the default
  `Content-Type`, `Content-Encoding`, `Content-Language`, `Content-Location` and
  `Content-Length`. A `Location` written in raw UTF-8 is followed, percent-encoded.
- **Cookies** — `session.cookies` is a `CookieJar` in the Playwright and Puppeteer cookie format,
  which also takes raw `Set-Cookie` values through `setRaw()`. An empty `Max-Age` counts as
  absent, so a past `Expires` still deletes the cookie.
- **Errors** — Failures are `RequestError` and its subclasses (`ConnectionError`,
  `TimeoutError`, `TlsError`, `ProxyError`, `HttpStatusError`, `TooManyRedirectsError`,
  `ResourceLimitError`), which carry a `code` (`ERR_LK_*`), upstream's `kind`, the `phase` that
  failed and the `retryable` and `safeToReplay` hints. A cancelled request rejects with
  `AbortError`, and `json()` on a body that is not JSON with `JsonDecodeError`.
- **WebSocket** — `session.websocket()` opens a connection that keeps the session's fingerprint,
  cookies and proxy, with handshake `headers`, `protocols`, `extensions` and `signal`. The
  `WebSocketConnection` sends, receives, pings, pongs and closes, iterates asynchronously and
  supports `Symbol.asyncDispose`; a send or a close does not wait for a pending receive.
- **Retries, Middleware And Hooks** — The session's `retry` takes the `exponential` or `fixed`
  strategy, or a function, possibly async, that decides each retry from
  `{ attempt, error, status }`. `middleware` on the client and the session runs `onRequest` and
  `onResponse` interceptors in onion order, which may change the method, URL, headers, body and
  status. The `onRequest` and `onResponse` event hooks observe each request and return an
  unsubscribe function.
- **HTTP/2 And HTTP/3** — `preferredHttpVersion` and `httpIntent` per session or request, and
  `protocolPolicy`: a preset, or an object that adjusts the policy in force axis by axis
  (`intent`, `acquisition` with a TCP/QUIC `race`, `upgrade`, `fallback`) on the client, the
  session or the request; contradictory combinations are refused. HTTP/3 comes with
  `brokenQuicPolicy` (and its cooldowns), `disableHttp3`, `timeouts.quicConnect`,
  `h3HeaderOrder`, and `h3RetryMode: "chrome_155_protocol_errors"`, which retries HTTP/3
  protocol errors as Chrome 155 does. An HTTP/2 request that is aborted, times out or has its
  streamed body cancelled resets its stream, so it frees its slot on the connection.
- **Proxies** — `ProxyConfig` for HTTP CONNECT, SOCKS5 and SOCKS5h proxies and multi-hop chains,
  with a user name and password, a static HTTP credential (`withHttpAuth`, in the header
  `withAuthHeader` picks) or one your code computes on every connection (`withCustomAuth`, for
  Digest or one-time tokens). `healthCheck()` measures how long a tunnel takes to open. When a
  proxy refuses the retry after a 407 challenge, the `ProxyError` names the status it answered.
  A request falls back to a direct connection only with `fallback.proxyToDirect`.
- **Pools** — `ProxyPool` rotates proxies, cools bad ones down and checks their health, leasing
  them with `acquire()` and `acquireFresh()` under a `maxConcurrent` limit. `SessionPool` leases
  ready sessions (`release()`, `Symbol.dispose`, or returned when garbage collected), and
  `ClientPool` rotates clients round robin or at random. `ProxyPool` and `SessionPool` also take
  a function in place of the proxy list, with `proxyBuffer` keeping a few proxies ready. A pool
  given proxies never leases without one: while every proxy cools down or the function fails,
  `acquire()` waits, and takes a `signal` to give up.
- **DNS And Addresses** — `dns` takes a preset (the system resolver, cached, public resolvers and
  DNS over HTTPS), `{ server }` for a DNS server of your own, or `{ resolve, lookupHttps? }` for
  your own functions, which may also return HTTPS records that make a request try HTTP/3.
  `dnsCache` caches the answers, `family` (`0`, `4` or `6`) limits the address family,
  `connectTo` pins the address dialled for a host, and `timeouts.dns` limits every DNS query,
  whichever resolver answers it (5 seconds by default).
- **TLS And HSTS** — `ca`, `caDer`, `rejectUnauthorized`, `useNativeCerts`, `ech` and
  `requireCloseNotify`; session resumption (`sessionResumption`, `tls.sessionResumptionPolicy`),
  its cache partitioned by `tls.sessionCachePartitionPolicy` and the session's
  `networkPartitionContext`; and `keylog` to a file or a function, for Wireshark. HSTS policies
  (`Hsts.none()`, `static()`, `dynamic()` or `custom()`) are shared between the sessions they are
  given to, next to `httpsOnly`.
- **Fingerprint Profiles** — `TlsProfile`, `H2Profile`, `TcpFingerprint` and `QuicProfile`, from
  a preset, built by hand or loaded from upstream's JSON format, override a preset's layers
  (`tlsProfile`, `h2Profile`, `tcpFingerprint`, `quicFingerprint`, `quicProfile`).
  `TlsProfile.fromClientHello()` and `H2Profile.fromH2Frames()` rebuild profiles from captured
  traffic, and `parseH3ControlStream()` reads a captured HTTP/3 control stream. `H2Profile` sets
  the first stream id and the stream dependency policy, `TcpFingerprint` takes JA4T, TCP options
  and keepalive, `H2Profile` and `QuicProfile` validate themselves, and the 62-bit values of a
  `QuicProfile` stay exact through JSON. `randomize` shuffles the TLS extension order on every
  connection or synthesizes whole fingerprints, and `client.fingerprintInfo()`,
  `randomizeFingerprint()` and `validateFingerprintConsistency()` inspect, vary and check them.
- **MASQUE (Experimental)** — `masque://` proxies (RFC 9298 CONNECT-UDP) carry HTTP/3, with the
  client's `masque` option for the outer hop (its own trust anchors, verification and tunnel
  limits) and the `tunnelProbe` health check. MASQUE is experimental upstream, so it may change
  in any release. A TCP request through a MASQUE proxy fails rather than going direct.
- **Observability** — Phase timings on every response (`diagnostics`), `node:diagnostics_channel`
  events (`lkrequest:request:start`, `end` and `error`) for tracing and APM tools,
  `enableMetrics()` with per-host counts and a latency histogram in Prometheus format,
  `metricsSnapshot()` for the transport counters, and the Rust log events through
  `setLogLevel()` and `onLog()`. `pendingRequests()` and `drainPending()` help a graceful
  shutdown.
