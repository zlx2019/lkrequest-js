/**
 * Public option and data types. Durations are in milliseconds and sizes in bytes throughout.
 *
 * @module
 */

import type { RequestError } from "./errors.js";
import type { H2Profile, QuicProfile, TcpFingerprint, TlsProfile } from "./fingerprint.js";
import type { RequestHook, ResponseHook } from "./hooks.js";
import type { Hsts } from "./hsts.js";
import type { Middleware } from "./middleware.js";
import type { ProxyConfig } from "./proxy.js";

/** Content codings lkrequest can decode and advertise in `Accept-Encoding`. */
export type ContentCoding = "gzip" | "br" | "deflate" | "zstd";

/**
 * How redirects are handled, as in the Fetch standard: `"follow"` follows them (up to
 * `maxRedirects`), `"manual"` returns the 3xx response itself, and `"error"` fails with
 * `TooManyRedirectsError` on the first redirect.
 */
export type RedirectMode = "follow" | "manual" | "error";

/** HTTP version of a response, spelled like Node's `IncomingMessage#httpVersion`. */
export type HttpVersion = "1.0" | "1.1" | "2.0" | "3.0" | "";

/**
 * Headers to send. Name/value pairs keep their order; a `Headers` instance sorts and
 * lower-cases its names, so prefer pairs when order matters.
 */
export type HeadersInput =
  | Headers
  | Readonly<Record<string, string>>
  | Iterable<readonly [string, string]>;

/** Name/value pairs, as a record or in order. */
export type PairsInput = Readonly<Record<string, string>> | Iterable<readonly [string, string]>;

/**
 * A request body. Strings, binary data, `Blob`, `URLSearchParams` and `FormData` follow the
 * Fetch standard, including the default `Content-Type`. Async iterables (a `ReadableStream`,
 * a Node.js `Readable`, an async generator) are streamed and pulled only as fast as the
 * connection sends them; a streamed body cannot be replayed for a redirect or a retry.
 */
export type BodyInit =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | URLSearchParams
  | FormData
  | AsyncIterable<Uint8Array | string>;

/**
 * Which HTTP version to use: `"auto"` lets ALPN and the protocol policy decide, the `*_only`
 * values force one version, and `"http3_with_fallback"` tries HTTP/3 before TCP.
 */
export type PreferredHttpVersion =
  | "auto"
  | "http1_only"
  | "http2_only"
  | "http3_only"
  | "http3_with_fallback";

/** A protocol policy preset steering HTTP/2 and HTTP/3 selection, racing and fallback. */
export type ProtocolPolicyPreset =
  | "chrome_standard"
  | "chrome_conservative"
  | "crawler_throughput"
  | "h3_strict";

/** How a connection that is not in the pool yet is acquired. */
export type AcquisitionPolicy =
  /** Reuse a healthy pooled connection; otherwise stay conservative about opening HTTP/3. */
  | "reuse_existing_first"
  /** Open the best protocol currently known to work. */
  | "establish_best_available"
  /** Start TCP and QUIC attempts and use whichever completes first. */
  | { readonly race: RacePolicy };

/** Parameters of a TCP-versus-QUIC race; what is left out keeps Chrome's behavior. */
export interface RacePolicy {
  /** Start a TCP attempt (default `true`). */
  readonly tcp?: boolean;
  /** Start a QUIC attempt (default `true`). */
  readonly quic?: boolean;
  /** Delay before the TCP attempt starts, in milliseconds (default 300): QUIC's head start. */
  readonly tcpDelay?: number;
  /** Delay before the QUIC attempt starts, in milliseconds (default 0). */
  readonly quicDelay?: number;
  /** Race only when the route has already advertised HTTP/3 (default `true`). */
  readonly onlyWhenH3Advertised?: boolean;
}

/** How HTTP/3 is adopted once a route is known to support it. */
export type UpgradePolicy =
  /** Never; stay on TCP. */
  | "off"
  /** Probe for HTTP/3 in the background, but keep serving over TCP. */
  | "probe_only"
  /** Probe, and move new requests to HTTP/3 once it is confirmed healthy. */
  | "probe_and_migrate"
  /** Send new requests over HTTP/3 as soon as the route is known to support it. */
  | "force_for_new_requests";

/** Whether a failed HTTP/3 attempt may fall back to TCP. */
export type FallbackPolicy =
  /** On any QUIC or HTTP/3 failure. */
  | "allow_fallback"
  /** Only on network-level failures, not on protocol errors. */
  | "allow_fallback_on_network_errors"
  /** Never; the failure reaches the caller. */
  | "no_fallback";

/**
 * A protocol policy built axis by axis: `preset` picks a starting point, the other fields
 * replace its parts. Without `preset`, the start is the policy already in force where the
 * option is set (the client's preset policy for a session, the session's for a request), so
 * `{ fallback: "no_fallback" }` changes that one setting and nothing else.
 *
 * `intent` is applied first and also brings the other axes in line with it (`"h2_only"`
 * turns fallback and upgrades off); the axes given explicitly then override that. A policy
 * that contradicts itself, such as `"h3_only"` with `"allow_fallback"`, is refused with a
 * `TypeError`.
 */
export interface ProtocolPolicyOptions {
  /** The policy to start from. */
  readonly preset?: ProtocolPolicyPreset;
  /** HTTP/2 versus HTTP/3 intent. */
  readonly intent?: HttpIntent;
  /** How a connection that is not in the pool yet is acquired. */
  readonly acquisition?: AcquisitionPolicy;
  /** How HTTP/3 is adopted once a route is known to support it. */
  readonly upgrade?: UpgradePolicy;
  /** Whether a failed HTTP/3 attempt may fall back to TCP. */
  readonly fallback?: FallbackPolicy;
}

/**
 * Steers HTTP/2 and HTTP/3 selection, racing and fallback: a preset name, or an object that
 * adjusts a policy axis by axis.
 *
 * A client without a browser preset starts from `"crawler_throughput"`; the browser presets
 * bring their own policy (`"chrome_standard"` for the Chrome ones). A session that sets none
 * uses the client's as it is, so the sessions of a Chrome preset race TCP against QUIC as
 * Chrome does.
 */
export type ProtocolPolicy = ProtocolPolicyPreset | ProtocolPolicyOptions;

/** The HTTP/2 versus HTTP/3 intent, applied on top of the protocol policy. */
export type HttpIntent =
  | "h2_only"
  | "h3_only"
  | "acquire_h3_when_viable"
  | "reuse_existing_protocol";

/**
 * A preset for how long an origin whose QUIC connection failed is kept on TCP: `"strict"`
 * (the default) backs off for minutes like Chrome, `"resilient"` for seconds, `"disabled"`
 * never.
 */
export type BrokenQuicPreset = "strict" | "resilient" | "disabled";

/**
 * Cooldown settings for origins whose QUIC connection failed; durations in milliseconds.
 * What is left out keeps the `"strict"` value. To never keep an origin on TCP, use
 * `"disabled"`.
 */
export interface BrokenQuicOptions {
  /** Cooldown after the first failure of an origin (default 300000). */
  readonly initialCooldown?: number;
  /** Longest cooldown after repeated failures (default 3600000). */
  readonly maxCooldown?: number;
  /** Consecutive failures after which the cooldown is the longest (default 4). */
  readonly escalationThreshold?: number;
  /**
   * Cooldown of a whole proxy route that cannot carry QUIC, such as a SOCKS5 proxy that
   * refuses UDP (default 1800000).
   */
  readonly routeCooldown?: number;
  /** Origins tracked at most; the oldest failure is dropped first (default 1024). */
  readonly maxEntries?: number;
  /** Proxy routes tracked at most (default 256). */
  readonly maxRouteEntries?: number;
}

/**
 * How long an origin whose QUIC connection failed is kept on TCP: a preset, or the cooldown
 * settings themselves.
 */
export type BrokenQuicPolicy = BrokenQuicPreset | BrokenQuicOptions;

/**
 * Whether a session retries HTTP/3 requests that fail with a protocol error.
 *
 * - `safe` (the default): only the usual replay rules apply.
 * - `chrome_155_protocol_errors`: as Chrome 155 does, a request that fails with an HTTP/3
 *   protocol error before its response headers arrive is sent again, at most twice per
 *   redirect, even a `POST` the server may already have processed. Requests with a streamed
 *   body, and those marked `idempotency: "not_idempotent"`, are not. An HTTP/3-only request
 *   is retried over HTTP/3; any other is retried over TCP when its protocol policy allows
 *   falling back, and not at all otherwise. The `retry` option does not retry such a failure
 *   again.
 */
export type H3RetryMode = "safe" | "chrome_155_protocol_errors";

/** Whether a request may be replayed in TLS early data or retried automatically. */
export type Idempotency = "default" | "idempotent" | "not_idempotent";

/**
 * A request priority (RFC 9218): a browser preset, or an urgency from 0 (highest) to 7 with an
 * incremental flag. Urgencies above 7 are clamped to 7.
 */
export type RequestPriority =
  | "navigation"
  | "fetch"
  | "css"
  | "script"
  | "image"
  | "background"
  | { readonly urgency: number; readonly incremental?: boolean };

/** A resolver preset; the `*_https` ones use DNS over HTTPS. */
export type DnsPreset =
  | "system"
  | "google"
  | "cloudflare"
  | "quad9"
  | "google_https"
  | "cloudflare_https"
  | "quad9_https";

/** A DNS server to query directly, over UDP and TCP, instead of the system resolver. */
export interface DnsServer {
  /**
   * The server's IP address with an optional port (default 53), written as Node's
   * `dns.setServers()` accepts it: `"1.1.1.1"`, `"1.1.1.1:5353"`, `"2606:4700::1111"` or
   * `"[2606:4700::1111]:5353"`. A host name is refused.
   */
  readonly server: string;
}

/** An HTTPS (SVCB) DNS record, which tells how to reach a host (RFC 9460). */
export interface HttpsRecord {
  /** Application protocols the endpoint speaks; `"h3"` makes the client try HTTP/3. */
  readonly alpn?: readonly string[];
  /** The protocol the URL scheme implies is not available here; only `alpn` is. */
  readonly noDefaultAlpn?: boolean;
  /** Name to connect to instead of the host. */
  readonly target?: string;
  /** Port to connect to instead of the URL's. */
  readonly port?: number;
  /** Encrypted Client Hello configuration list. */
  readonly ech?: Uint8Array;
  /** IPv4 addresses the endpoint is reachable at; parsed, but connections do not use them. */
  readonly ipv4Hints?: readonly string[];
  /** IPv6 addresses the endpoint is reachable at; parsed, but connections do not use them. */
  readonly ipv6Hints?: readonly string[];
}

/**
 * A resolver written in JavaScript. Its functions run on the main thread while a request
 * waits, and each call has the time limit of `timeouts.dns`. A lookup that throws, returns
 * something invalid or runs out of time fails the connection it was for: a direct TCP
 * connection then fails with a `ConnectionError`, or a `TimeoutError` when time ran out. A
 * proxy's own address is looked up here too; the target's name is not when the proxy resolves
 * it itself (`socks5h://`, HTTP `CONNECT`).
 */
export interface CustomDnsResolver {
  /**
   * Resolves `host` to the addresses to try, in order: IP addresses (the request's port
   * applies) or `ip:port` pairs, IPv6 with a port as `[::1]:443`. The result may be a Promise.
   * `family` applies to what is returned.
   */
  resolve(host: string, port: number): readonly string[] | Promise<readonly string[]>;
  /**
   * Looks up the HTTPS record of `host`, which tells whether it speaks HTTP/3 and carries
   * Encrypted Client Hello keys. Returns `null` or `undefined` when there is none. Optional:
   * without it no HTTPS records are looked up. The client asks for requests that could use
   * HTTP/3, once per request on a new connection, so cache in here when the lookup is costly.
   */
  lookupHttps?(
    host: string,
  ): HttpsRecord | null | undefined | Promise<HttpsRecord | null | undefined>;
}

/** What resolves host names: a preset, a DNS server of your own, or a resolver in JavaScript. */
export type DnsResolver = DnsPreset | DnsServer | CustomDnsResolver;

/** Which TLS resumption modes the ClientHello advertises (a fingerprint property). */
export type SessionResumption =
  | "chrome"
  | "firefox"
  | "disabled"
  | {
      /** Offer TLS 1.3 PSK resumption (default `true`). */
      readonly tls13Psk?: boolean;
      /** Offer TLS 1.2 session tickets (default `true`). */
      readonly tls12SessionTicket?: boolean;
      /** Store the tickets servers issue (default `true`). */
      readonly storeTickets?: boolean;
      /** Tickets kept per host (unbounded by default). */
      readonly maxTicketsPerHost?: number;
    };

/** Whether TLS session tickets are cached and offered as PSKs, and how many per server. */
export type TlsSessionResumptionPolicy =
  | "browser_default"
  | "disabled"
  | { readonly maxTicketsPerServer: number };

/**
 * How the session-ticket cache is partitioned by browsing context. Browser presets already
 * carry the matching policy; set it only when building a client by hand.
 */
export type TlsSessionCachePartitionPolicy =
  | "unpartitioned"
  | "top_level_site"
  | "top_level_and_frame_site"
  | "chromium"
  | "firefox";

/**
 * How outbound HTTP/2 DATA payloads are capped: the preset's own behavior, the peer's
 * `SETTINGS_MAX_FRAME_SIZE`, a fixed payload size, or a socket write size that includes the
 * 9-byte frame header.
 */
export type H2DataFramePolicy =
  | "browser_default"
  | "peer_max_frame_size"
  | { readonly fixedPayload: number }
  | { readonly socketWriteAligned: number };

/** A browsing context the session-ticket cache is partitioned by. */
export interface NetworkPartitionContext {
  /** Schemeful top-level site, such as `https://example.com` (not a full URL). */
  readonly topLevelSite: string;
  /** Schemeful site of the frame making the requests. */
  readonly frameSite: string;
  /** Transient partition nonce, for isolated contexts. */
  readonly nonce?: string;
  /** Opaque browser context, such as Firefox's origin attributes. */
  readonly browserContext?: string;
}

/** Connection pool statistics of a session. */
export interface PoolStats {
  /** Idle HTTP/1.1 connections; one serving a request is not idle. */
  readonly h1Connections: number;
  /** HTTP/2 connections. */
  readonly h2Connections: number;
  /** HTTP/3 connections. */
  readonly h3Connections: number;
  /** Connections counted against the limit, including those serving requests. */
  readonly total: number;
  /** The connection limit; `Infinity` when there is none. */
  readonly maxTotal: number;
  /** Whether the limit is reached, so a new connection would be refused. */
  readonly atCapacity: boolean;
}

/** The outcome of preparing a connection to one URL. */
export interface PreconnectResult {
  /** The URL as given. */
  readonly url: string;
  /** Whether the connection is ready. */
  readonly ok: boolean;
  /** Why it is not. */
  readonly error?: RequestError;
}

/** The outcome of prefetching one URL. */
export interface PrefetchResult extends PreconnectResult {
  /** Time spent. */
  readonly duration: number;
}

/**
 * A built-in retry strategy; delays in milliseconds. `"exponential"` doubles the delay from
 * `baseDelay` (default 1000) up to `maxDelay` (default 30000), randomized unless `jitter` is
 * false; `"fixed"` waits `interval` (default 1000). Both stop after `maxRetries` (default 3).
 */
export type RetryStrategy =
  | {
      readonly strategy: "exponential";
      readonly maxRetries?: number;
      readonly baseDelay?: number;
      readonly maxDelay?: number;
      readonly jitter?: boolean;
    }
  | { readonly strategy: "fixed"; readonly maxRetries?: number; readonly interval?: number };

/** What a retry function decides about: a failed attempt or a retryable status. */
export interface RetryContext {
  /** 1 for the first retry, 2 for the second, and so on. */
  readonly attempt: number;
  /** The error, when the attempt failed. */
  readonly error?: RequestError;
  /** The status, when the server answered with a retryable one (429, 503, ...). */
  readonly status?: number;
}

/**
 * Decides whether to retry: the delay in milliseconds before the next attempt, or `null` /
 * `undefined` to stop. It may return a Promise. A function that throws, or takes longer than
 * 30 seconds, stops the retries. Requests that are not safe to replay (a `POST` the server may
 * have processed, a streamed body) are not retried whatever it returns.
 */
export type RetryFunction = (
  context: RetryContext,
) => number | null | undefined | Promise<number | null | undefined>;

/**
 * Fingerprint randomization. `"off"` (the default) and `"extension_order"` (per-connection
 * TLS extension order, still a real browser) keep a browser's fingerprint. `"recombine"` and
 * `"full"` synthesize a fingerprint that matches no real browser, a different one per
 * session, for targets that block known browsers; `layers` limits which layers vary and
 * `negotiability` how far the signature algorithms may drift. The synthetic modes need the
 * `synthetic-fp` feature (release builds have it).
 */
export type Randomize =
  | "off"
  | "extension_order"
  | {
      readonly mode: "recombine" | "full";
      readonly layers?: ReadonlyArray<"tls" | "h2" | "quic">;
      readonly negotiability?: "universal" | "preset_family" | readonly number[];
    };

/**
 * The outer hop to a `masque://` proxy (RFC 9298 CONNECT-UDP), the HTTP/3 connection tunnels
 * ride on. Experimental upstream. Trust is configured here, apart from the client's `tls`
 * options, which only govern the tunneled connection to the origin; the outer connection
 * carries no browser fingerprint, the tunneled one still does.
 */
export interface MasqueOptions {
  /** Name to verify the proxy's certificate against, instead of its host. */
  readonly serverName?: string;
  /** Extra trust anchors for the proxy, as PEM (one document or several). */
  readonly ca?: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
  /** Also trust the operating system's certificate store (default `true`). */
  readonly useNativeCerts?: boolean;
  /**
   * Verify the proxy's certificate (default `true`). `false` is for development only: anyone
   * answering on the proxy's address then sees every tunnel's target.
   */
  readonly rejectUnauthorized?: boolean;
  /** How long an idle tunnel is kept, in milliseconds; `null` keeps it (default 120000). */
  readonly tunnelIdleTimeout?: number | null;
  /** Idle tunnels kept at most; `0` removes the cap (default 256). */
  readonly maxIdleTunnels?: number;
}

/** Credentials sent in the `Authorization` header. */
export type Auth =
  | { readonly bearer: string }
  | { readonly username: string; readonly password?: string };

/** Phase time limits of a client. */
export interface TimeoutOptions {
  /**
   * Each DNS query, address and HTTPS record lookups alike, whichever resolver answers it, one
   * written in JavaScript included (default 5000).
   */
  readonly dns?: number;
  /** TCP connect. */
  readonly tcpConnect?: number;
  /** TLS handshake. */
  readonly tlsHandshake?: number;
  /** Time to the first response byte. */
  readonly ttfb?: number;
  /** The whole request, redirects included. */
  readonly total?: number;
  /** QUIC handshake. */
  readonly quicConnect?: number;
}

/** Resource limits of a client. */
export interface LimitOptions {
  /** Largest accepted response body. */
  readonly maxResponseBodySize?: number;
  /** Upper bound on connections per session. */
  readonly maxConnectionsPerSession?: number;
  /** Upper bound on queued HTTP/2 requests per connection (unbounded by default). */
  readonly maxPendingH2Requests?: number;
  /** Largest accepted number of response headers. */
  readonly maxHeaderCount?: number;
  /** Largest accepted single response header. */
  readonly maxHeaderSize?: number;
  /** Largest accepted response header block. */
  readonly maxHeadersTotalSize?: number;
  /** Fail a transfer that stays slower than `bytesPerSecond` over `window`. */
  readonly minTransferRate?: { readonly bytesPerSecond: number; readonly window?: number };
}

/** TLS options of a client, named after Node's `tls` module where one exists. */
export interface TlsOptions {
  /** Extra trust anchors as PEM, one document or several. */
  readonly ca?: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
  /** Extra trust anchors as DER certificates. */
  readonly caDer?: Uint8Array | readonly Uint8Array[];
  /** Verify server certificates (default `true`). */
  readonly rejectUnauthorized?: boolean;
  /** Also trust the operating system's certificate store. */
  readonly useNativeCerts?: boolean;
  /** Encrypted Client Hello configuration list. */
  readonly ech?: Uint8Array;
  /**
   * Where TLS secrets go, in NSS key log format (for Wireshark): a file to append to, or a
   * function called with each line (without the line break). The function runs on the main
   * thread after the handshake, and an exception it throws is logged, not raised.
   */
  readonly keylog?: string | ((line: string) => void);
  /** Treat a TLS connection closed without `close_notify` as an error. */
  readonly requireCloseNotify?: boolean;
  /** Whether session tickets are cached and offered (default `"browser_default"`). */
  readonly sessionResumptionPolicy?: TlsSessionResumptionPolicy;
  /** How the session-ticket cache is partitioned by browsing context. */
  readonly sessionCachePartitionPolicy?: TlsSessionCachePartitionPolicy;
}

/** Options of a {@link Client}. */
export interface ClientOptions {
  /** Browser preset to emulate, for example `"chrome_155"`; see `listPresets()`. */
  readonly preset?: string;
  /** TLS fingerprint, overriding the preset's: a `TlsProfile` or a TLS preset name. */
  readonly tlsProfile?: string | TlsProfile;
  /** HTTP/2 fingerprint, overriding the preset's: an `H2Profile` or a preset name. */
  readonly h2Profile?: string | H2Profile;
  /** TCP fingerprint, overriding the preset's: a `TcpFingerprint`, a preset name or JA4T. */
  readonly tcpFingerprint?: string | TcpFingerprint;
  /** ClientHello sent inside QUIC: a `TlsProfile` or a TLS preset name (`chrome_155_quic`). */
  readonly quicFingerprint?: string | TlsProfile;
  /** QUIC / HTTP/3 fingerprint: a `QuicProfile` or a preset name. */
  readonly quicProfile?: string | QuicProfile;
  /** Fingerprint randomization (default `"off"`). */
  readonly randomize?: Randomize;
  /** Headers sent with every request. A name given more than once keeps only its last value. */
  readonly defaultHeaders?: HeadersInput;
  /** Header order for HTTP/1.1 and HTTP/2 requests. */
  readonly headerOrder?: readonly string[];
  /** Order of cookies in the `Cookie` header. */
  readonly cookieOrder?: readonly string[];
  /** Header order for HTTP/3 requests. */
  readonly h3HeaderOrder?: readonly string[];
  /** Phase time limits. */
  readonly timeouts?: TimeoutOptions;
  /** Resource limits. */
  readonly limits?: LimitOptions;
  /** HTTP/2 tuning. */
  readonly h2?: {
    /** Ready requests coalesced into one write turn (default 1, the browser-like shape). */
    readonly dispatchBatchSize?: number;
    /** How outbound DATA payloads are capped (default `"browser_default"`). */
    readonly dataFramePolicy?: H2DataFramePolicy;
  };
  /** Automatic fallbacks. */
  readonly fallback?: {
    /** Retry over HTTP/1.1 when HTTP/2 negotiation fails. */
    readonly h2ToH1?: boolean;
    /** Connect directly when the proxy cannot be reached. */
    readonly proxyToDirect?: boolean;
    /** Retry once when a pooled connection turns out to be closed. */
    readonly retryOnConnectionClose?: boolean;
  };
  /** TLS options. */
  readonly tls?: TlsOptions;
  /** Which TLS resumption modes the ClientHello advertises. */
  readonly sessionResumption?: SessionResumption;
  /**
   * How host names are resolved (default `"system"`): a preset, or `{ server }`. Cannot be
   * combined with `dnsCache`. `family` applies to the addresses either way.
   */
  readonly dns?: DnsResolver;
  /** Cache the system resolver's answers for `ttl` milliseconds. */
  readonly dnsCache?: { readonly ttl: number; readonly maxEntries?: number };
  /**
   * Address family to connect over, as in Node's `net` module: `0` (any, the default), `4` or
   * `6`. It covers every address this process dials (targets, proxies, QUIC) and never falls
   * back to another family. A proxy that resolves the target itself picks its own family; use
   * `connectTo` to hand it an address.
   */
  readonly family?: 0 | 4 | 6;
  /**
   * Fixed addresses to dial per origin, as `{ "host:port": "ip:port" }` (IPv6 in brackets).
   * The URL, TLS server name, `Host` header, cookies and pooling keep the original host.
   */
  readonly connectTo?: PairsInput;
  /** Protocol policy (default: the browser preset's own, else `"crawler_throughput"`). */
  readonly protocolPolicy?: ProtocolPolicy;
  /** Never attempt HTTP/3. */
  readonly disableHttp3?: boolean;
  /** Middleware around every request of the client's sessions, before the session's own. */
  readonly middleware?: readonly Middleware[];
  /** The outer hop of `masque://` proxies. */
  readonly masque?: MasqueOptions;
}

/** Options of a {@link Session}. */
export interface SessionOptions {
  /** Proxy (or chain of proxies) for every request, as a URL or a `ProxyConfig`. */
  readonly proxy?: string | ProxyConfig;
  /** Redirect handling (default `"follow"`). */
  readonly redirect?: RedirectMode;
  /** Redirects to follow before failing (default 10). */
  readonly maxRedirects?: number;
  /** Base that relative request URLs are resolved against, like `new URL(url, baseUrl)`. */
  readonly baseUrl?: string | URL;
  /** Content codings to advertise in `Accept-Encoding`. */
  readonly acceptEncoding?: readonly ContentCoding[];
  /** Upper bound on connections this session keeps open. */
  readonly maxConnections?: number;
  /** How long an idle pooled connection is kept. */
  readonly idleTimeout?: number;
  /** Header order, overriding the client's. */
  readonly headerOrder?: readonly string[];
  /** Cookie order, overriding the client's. */
  readonly cookieOrder?: readonly string[];
  /** HTTP/3 header order, overriding the client's. */
  readonly h3HeaderOrder?: readonly string[];
  /** Which HTTP version to use (default `"auto"`). */
  readonly preferredHttpVersion?: PreferredHttpVersion;
  /** Protocol policy, overriding the client's. */
  readonly protocolPolicy?: ProtocolPolicy;
  /** HTTP/2 versus HTTP/3 intent, applied on top of the protocol policy. */
  readonly httpIntent?: HttpIntent;
  /** How long an origin whose QUIC connection failed is kept on TCP (default `"strict"`). */
  readonly brokenQuicPolicy?: BrokenQuicPolicy;
  /** Whether HTTP/3 protocol errors are retried as Chrome 155 does (default `"safe"`). */
  readonly h3RetryMode?: H3RetryMode;
  /** Refuse `http://` URLs. */
  readonly httpsOnly?: boolean;
  /** Which `http://` hosts are upgraded to `https://` (default: none). */
  readonly hsts?: Hsts;
  /** Browsing context the session-ticket cache is partitioned by. */
  readonly networkPartitionContext?: NetworkPartitionContext;
  /** Encrypted Client Hello configuration list, overriding the client's. */
  readonly ech?: Uint8Array;
  /** Retries failed attempts and retryable statuses (none by default). */
  readonly retry?: RetryStrategy | RetryFunction;
  /** Middleware around every request, after the client's. */
  readonly middleware?: readonly Middleware[];
  /** Hook called before each request; more can be added with `session.onRequest()`. */
  readonly onRequest?: RequestHook;
  /** Hook called after each response; more can be added with `session.onResponse()`. */
  readonly onResponse?: ResponseHook;
}

/** Options of a single request. */
export interface RequestOptions {
  /** HTTP method (default `"GET"`). */
  readonly method?: string;
  /**
   * Request headers. A name that appears more than once among pairs is sent once per value,
   * in order (a `Headers` instance has already joined such values with `, `). A name given
   * here replaces every value `defaultHeaders` has for it.
   */
  readonly headers?: HeadersInput;
  /** Query parameters appended to the URL. */
  readonly params?: URLSearchParams | string | PairsInput;
  /** A value serialized with `JSON.stringify`, sent as `application/json`. */
  readonly json?: unknown;
  /** The request body; cannot be combined with `json`. */
  readonly body?: BodyInit;
  /** Exact length of a streamed `body`; without it HTTP/1.1 uses chunked framing. */
  readonly contentLength?: number;
  /** Cookies sent along with the session's own. */
  readonly cookies?: PairsInput;
  /** Cookies that replace the session's cookies of the same name for this request. */
  readonly cookieOverride?: PairsInput;
  /** Time limit for the whole request. */
  readonly timeout?: number;
  /** Credentials for the `Authorization` header. */
  readonly auth?: Auth;
  /** Decode `Content-Encoding` (default `true`); `false` returns the body as received. */
  readonly decompress?: boolean;
  /** Content codings to advertise, overriding the session's. */
  readonly acceptEncoding?: readonly ContentCoding[];
  /** Header order, overriding the session's. */
  readonly headerOrder?: readonly string[];
  /** Cookie order, overriding the session's. */
  readonly cookieOrder?: readonly string[];
  /** HTTP/3 header order, overriding the session's. */
  readonly h3HeaderOrder?: readonly string[];
  /** Request priority (RFC 9218). */
  readonly priority?: RequestPriority;
  /**
   * HTTP/2 stream weight as the HEADERS frame carries it, 0 to 255 (the weight minus one),
   * instead of the one the profile derives from `priority`; the `priority` header stays as it
   * is. Firefox, for one, sets the two independently. Has no effect on HTTP/1.1 and HTTP/3, or
   * on profiles that send no HEADERS priority.
   */
  readonly h2PriorityWeight?: number;
  /** Which HTTP version to use, overriding the session's; `"auto"` lifts its restriction. */
  readonly preferredHttpVersion?: PreferredHttpVersion;
  /** Whether the request may be replayed in early data or retried. */
  readonly idempotency?: Idempotency;
  /** Protocol policy, overriding the session's. */
  readonly protocolPolicy?: ProtocolPolicy;
  /** HTTP/2 versus HTTP/3 intent, overriding the session's. */
  readonly httpIntent?: HttpIntent;
  /** Proxy URL for this request, overriding the session's; an invalid URL is refused. */
  readonly proxy?: string;
  /** Aborts the request; it then rejects with `AbortError` whose `cause` is `signal.reason`. */
  readonly signal?: AbortSignal;
}

/** Per-request timings and transport details; a phase that did not run is absent. */
export interface Diagnostics {
  /** DNS resolution time. */
  readonly dnsMs?: number;
  /** TCP connect time. */
  readonly tcpMs?: number;
  /** TLS handshake time. */
  readonly tlsMs?: number;
  /** Time to the first response byte. */
  readonly ttfbMs?: number;
  /** Total time measured by the transport. */
  readonly totalMs?: number;
  /** Remote `ip:port` the request was sent to. */
  readonly remoteAddr?: string;
  /** Negotiated application protocol, for example `"h2"`. */
  readonly protocol?: string;
  /** Negotiated TLS cipher suite. */
  readonly cipherSuite?: string;
}

/** One redirect hop that led to a response. */
export interface RedirectRecord {
  /** URL that answered with the redirect. */
  readonly url: string;
  /** Redirect status code. */
  readonly status: number;
  /** Headers of the redirect response. */
  readonly headers: Headers;
  /** Absolute URL the redirect pointed to. */
  readonly location: string;
}
