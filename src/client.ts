import type {
  NativeClient,
  NativeClientOptions,
  NativeFingerprints,
  NativeH2DataFramePolicy,
  NativeHttpsRecord,
  NativeRandomize,
  NativeResumptionPolicy,
  NativeSessionOptions,
  NativeSessionResumption,
} from "../native/index.cjs";
import type { RequestError } from "./errors.js";
import {
  type FingerprintInfo,
  H2Profile,
  QuicProfile,
  TcpFingerprint,
  TlsProfile,
} from "./fingerprint.js";
import { Hsts } from "./hsts.js";
import { toDialOverrides } from "./internal/connect-to.js";
import { Hooks } from "./internal/interceptors.js";
import { warnFailure } from "./internal/log.js";
import { toNativeMasqueOptions } from "./internal/masque.js";
import { native } from "./internal/native.js";
import { callNative, fromNativeError, invalidConfig } from "./internal/native-error.js";
import { flattenHeaders } from "./internal/pairs.js";
import { toNativeBrokenQuicPolicy, toNativeProtocolPolicy } from "./internal/protocol.js";
import type { Middleware } from "./middleware.js";
import { ProxyConfig } from "./proxy.js";
import type { Response } from "./response.js";
import { type MethodOptions, Session } from "./session.js";
import type {
  ClientOptions,
  CustomDnsResolver,
  DnsResolver,
  H2DataFramePolicy,
  HttpsRecord,
  Randomize,
  RequestOptions,
  RetryFunction,
  RetryStrategy,
  SessionOptions,
  SessionResumption,
  TlsOptions,
  TlsSessionResumptionPolicy,
} from "./types.js";

const encoder = new TextEncoder();

/**
 * Fingerprint, TLS and connection configuration shared by its sessions.
 *
 * @example
 * ```ts
 * const client = new Client({ preset: "chrome_155" });
 * const session = client.session();
 * const res = await session.get("https://example.com");
 * ```
 */
export class Client {
  readonly #native: NativeClient;
  readonly #options: ClientOptions;
  readonly #middleware: readonly Middleware[];

  /** Builds a client; an invalid option throws `TypeError` with code `ERR_LK_INVALID_CONFIG`. */
  constructor(options: ClientOptions = {}) {
    // Options the facade rejects itself already throw the right error, outside `callNative`.
    const nativeOptions = toNativeClientOptions(options);
    const fingerprints = toNativeFingerprints(options);
    this.#native = callNative(() => new native.NativeClient(nativeOptions, fingerprints));
    this.#options = options;
    this.#middleware = [...(options.middleware ?? [])];
  }

  /** Creates a session with its own connections and cookies. */
  session(options: SessionOptions = {}): Session {
    const hsts = options.hsts === undefined ? undefined : Hsts.toNative(options.hsts);
    const proxy = options.proxy === undefined ? undefined : ProxyConfig.toNative(options.proxy);
    const nativeSession = callNative(() =>
      this.#native.session(toNativeSessionOptions(options), hsts, proxy),
    );
    const hooks = new Hooks();
    if (options.onRequest) hooks.addRequestHook(options.onRequest);
    if (options.onResponse) hooks.addResponseHook(options.onResponse);
    return Session.fromNative(nativeSession, {
      baseUrl: options.baseUrl === undefined ? undefined : new URL(options.baseUrl).href,
      middleware: [...this.#middleware, ...(options.middleware ?? [])],
      hooks,
    });
  }

  /**
   * Sends a request with a session of its own, which is closed once the response has arrived:
   * no connection or cookie outlives the call. The client's middleware runs, and relative URLs
   * are not resolved (there is no `baseUrl`). To send more than one request, create a session
   * with {@link Client.session}, which reuses connections and keeps cookies.
   */
  async request(url: string | URL, options?: RequestOptions): Promise<Response> {
    const session = this.session();
    try {
      return await session.request(url, options);
    } finally {
      session.close();
    }
  }

  /** Sends a `GET` request with a session of its own; see {@link Client.request}. */
  get(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "GET" });
  }

  /** Sends a `POST` request with a session of its own; see {@link Client.request}. */
  post(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "POST" });
  }

  /** Sends a `PUT` request with a session of its own; see {@link Client.request}. */
  put(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "PUT" });
  }

  /** Sends a `DELETE` request with a session of its own; see {@link Client.request}. */
  delete(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "DELETE" });
  }

  /** Sends a `HEAD` request with a session of its own; see {@link Client.request}. */
  head(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "HEAD" });
  }

  /** Sends a `PATCH` request with a session of its own; see {@link Client.request}. */
  patch(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "PATCH" });
  }

  /** Sends an `OPTIONS` request with a session of its own; see {@link Client.request}. */
  options(url: string | URL, options?: MethodOptions): Promise<Response> {
    return this.request(url, { ...options, method: "OPTIONS" });
  }

  /** @internal The native client, for the pools. */
  static toNative(client: Client): NativeClient {
    return client.#native;
  }

  /** @internal The client's middleware, for sessions the pools create. */
  static middlewareOf(client: Client): readonly Middleware[] {
    return client.#middleware;
  }

  /** What the client fingerprints as. */
  fingerprintInfo(): FingerprintInfo {
    const { tlsProfile, h2SettingsCount, h2WindowUpdate, tcpJa4T } = this.#native.fingerprintInfo;
    return {
      tlsProfile,
      h2SettingsCount,
      h2WindowUpdate,
      ...(tcpJa4T != null && { tcpJa4t: tcpJa4T }),
    };
  }

  /**
   * A new client with the same options whose TLS extension order is shuffled on every
   * connection (or, with `shuffleExtensions: false`, explicitly not), to make connections
   * harder to correlate.
   */
  randomizeFingerprint(options: { readonly shuffleExtensions?: boolean } = {}): Client {
    const current = TlsProfile.fromNative(this.#native.tlsProfile());
    return new Client({
      ...this.#options,
      tlsProfile: current.withShuffledExtensions(options.shuffleExtensions ?? true),
    });
  }

  /** Ready HTTP/2 requests coalesced into one write turn. */
  get h2DispatchBatchSize(): number {
    return this.#native.h2DispatchBatchSize;
  }

  /** Whether a TLS connection closed without `close_notify` is treated as an error. */
  get requireCloseNotify(): boolean {
    return this.#native.requireCloseNotify;
  }

  /** Whether TLS session tickets are cached and offered, as configured or by default. */
  get tlsSessionResumptionPolicy(): TlsSessionResumptionPolicy {
    const { mode, maxTicketsPerServer } = this.#native.tlsSessionResumptionPolicy;
    return mode === "enabled" && maxTicketsPerServer != null
      ? { maxTicketsPerServer }
      : (mode as "browser_default" | "disabled");
  }
}

/** Flattens the grouped public client options into the native shape. */
function toNativeClientOptions(options: ClientOptions): NativeClientOptions {
  const { timeouts = {}, limits = {}, tls = {} } = options;
  return {
    ...(options.preset !== undefined && { preset: options.preset }),
    ...(options.defaultHeaders !== undefined && {
      defaultHeaders: flattenHeaders(options.defaultHeaders),
    }),
    ...(options.headerOrder !== undefined && { headerOrder: [...options.headerOrder] }),
    ...(options.cookieOrder !== undefined && { cookieOrder: [...options.cookieOrder] }),
    ...(options.h3HeaderOrder !== undefined && { h3HeaderOrder: [...options.h3HeaderOrder] }),
    dnsTimeout: timeouts.dns,
    tcpConnectTimeout: timeouts.tcpConnect,
    tlsHandshakeTimeout: timeouts.tlsHandshake,
    ttfbTimeout: timeouts.ttfb,
    totalTimeout: timeouts.total,
    quicConnectTimeout: timeouts.quicConnect,
    maxResponseBodySize: limits.maxResponseBodySize,
    maxConnectionsPerSession: limits.maxConnectionsPerSession,
    maxPendingH2Requests: limits.maxPendingH2Requests,
    maxHeaderCount: limits.maxHeaderCount,
    maxHeaderSize: limits.maxHeaderSize,
    maxHeadersTotalSize: limits.maxHeadersTotalSize,
    minTransferRate: limits.minTransferRate?.bytesPerSecond,
    minTransferRateWindow: limits.minTransferRate?.window,
    h2DispatchBatchSize: options.h2?.dispatchBatchSize,
    ...(options.h2?.dataFramePolicy !== undefined && {
      h2DataFramePolicy: toNativeDataFramePolicy(options.h2.dataFramePolicy),
    }),
    h2FallbackH1: options.fallback?.h2ToH1,
    proxyFallbackDirect: options.fallback?.proxyToDirect,
    retryOnConnectionClose: options.fallback?.retryOnConnectionClose,
    ...toNativeTlsOptions(tls),
    ...(options.sessionResumption !== undefined && {
      sessionResumption: toNativeSessionResumption(options.sessionResumption),
    }),
    ...(options.dns !== undefined && toNativeDns(options.dns)),
    dnsCacheTtl: options.dnsCache?.ttl,
    dnsCacheMaxEntries: options.dnsCache?.maxEntries,
    family: options.family,
    ...(options.connectTo !== undefined && { connectTo: toDialOverrides(options.connectTo) }),
    ...(options.protocolPolicy !== undefined && {
      protocolPolicy: toNativeProtocolPolicy(options.protocolPolicy),
    }),
    disableHttp3: options.disableHttp3,
    ...(options.randomize !== undefined && { randomize: toNativeRandomize(options.randomize) }),
    ...(options.masque !== undefined && { masque: toNativeMasqueOptions(options.masque) }),
  };
}

/** Spells the `dns` option as a preset name, a server address, or the resolver's callbacks. */
function toNativeDns(
  dns: DnsResolver,
): Pick<NativeClientOptions, "dns" | "dnsServer" | "dnsResolve" | "dnsLookupHttps"> {
  if (typeof dns === "string") return { dns };
  if (typeof dns === "object" && dns !== null) {
    if ("server" in dns) return { dnsServer: dns.server };
    if ("resolve" in dns && typeof dns.resolve === "function") return toNativeResolver(dns);
  }
  throw invalidConfig("dns must be a resolver preset name, { server }, or { resolve }");
}

/** Wraps a JavaScript resolver's functions so that they always return a Promise. */
function toNativeResolver(
  resolver: CustomDnsResolver,
): Pick<NativeClientOptions, "dnsResolve" | "dnsLookupHttps"> {
  return {
    dnsResolve: async (host, port) => {
      const addresses: unknown = await resolver.resolve(host, port);
      if (!Array.isArray(addresses)) {
        throw new TypeError("dns.resolve must return an array of addresses");
      }
      return addresses.map(String);
    },
    ...(typeof resolver.lookupHttps === "function" && {
      dnsLookupHttps: async (host: string) =>
        toNativeHttpsRecord(await resolver.lookupHttps?.(host)),
    }),
  };
}

/** The native shape of an HTTPS record; no record is `null`. */
function toNativeHttpsRecord(record: HttpsRecord | null | undefined): NativeHttpsRecord | null {
  if (record === null || record === undefined) return null;
  return {
    ...record,
    alpn: record.alpn === undefined ? undefined : [...record.alpn],
    ipv4Hints: record.ipv4Hints === undefined ? undefined : [...record.ipv4Hints],
    ipv6Hints: record.ipv6Hints === undefined ? undefined : [...record.ipv6Hints],
  };
}

/** Spells the `tls.keylog` option as a file path or a function that never throws. */
function toNativeKeylog(
  keylog: NonNullable<TlsOptions["keylog"]>,
): Pick<NativeClientOptions, "keylog" | "keylogFn"> {
  if (typeof keylog === "string") return { keylog };
  if (typeof keylog !== "function") {
    throw invalidConfig("tls.keylog must be a file path or a function");
  }
  return {
    keylogFn: (line) => {
      try {
        keylog(line);
      } catch (error) {
        warnFailure("the tls.keylog function", error);
      }
    },
  };
}

/** The fingerprint profile objects, with preset names resolved to profiles. */
function toNativeFingerprints(options: ClientOptions): NativeFingerprints {
  return {
    ...(options.tlsProfile !== undefined && {
      tlsProfile: TlsProfile.toNative(options.tlsProfile),
    }),
    ...(options.h2Profile !== undefined && { h2Profile: H2Profile.toNative(options.h2Profile) }),
    ...(options.tcpFingerprint !== undefined && {
      tcpFingerprint: TcpFingerprint.toNative(options.tcpFingerprint),
    }),
    ...(options.quicFingerprint !== undefined && {
      quicFingerprint: TlsProfile.toNative(options.quicFingerprint),
    }),
    ...(options.quicProfile !== undefined && {
      quicProfile: QuicProfile.toNative(options.quicProfile),
    }),
  };
}

/** Spells a randomization policy as a mode with its synthetic settings. */
function toNativeRandomize(randomize: Randomize): NativeRandomize {
  if (typeof randomize === "string") return { mode: randomize };
  const { negotiability } = randomize;
  return {
    mode: randomize.mode,
    ...(randomize.layers !== undefined && { layers: [...randomize.layers] }),
    ...(typeof negotiability === "string" && { negotiability }),
    ...(Array.isArray(negotiability) && { negotiabilitySigAlgs: [...negotiability] }),
  };
}

/** Spells a DATA frame policy as a mode and an optional size. */
function toNativeDataFramePolicy(policy: H2DataFramePolicy): NativeH2DataFramePolicy {
  if (typeof policy === "string") return { mode: policy };
  return "fixedPayload" in policy
    ? { mode: "fixed_payload", size: policy.fixedPayload }
    : { mode: "socket_write_aligned", size: policy.socketWriteAligned };
}

/** Spells the advertised resumption modes as a preset or individual switches. */
function toNativeSessionResumption(resumption: SessionResumption): NativeSessionResumption {
  return typeof resumption === "string" ? { preset: resumption } : { ...resumption };
}

/** Spells a ticket-cache policy as a mode and an optional capacity. */
function toNativeResumptionPolicy(policy: TlsSessionResumptionPolicy): NativeResumptionPolicy {
  return typeof policy === "string"
    ? { mode: policy }
    : { mode: "enabled", maxTicketsPerServer: policy.maxTicketsPerServer };
}

/** Flattens the TLS options; PEM strings are encoded, single values become lists. */
function toNativeTlsOptions(tls: TlsOptions): Partial<NativeClientOptions> {
  return {
    ...(tls.ca !== undefined && {
      caPem: asList(tls.ca).map((pem) => (typeof pem === "string" ? encoder.encode(pem) : pem)),
    }),
    ...(tls.caDer !== undefined && { caDer: asList(tls.caDer) }),
    rejectUnauthorized: tls.rejectUnauthorized,
    useNativeCerts: tls.useNativeCerts,
    ech: tls.ech,
    ...(tls.keylog !== undefined && toNativeKeylog(tls.keylog)),
    requireCloseNotify: tls.requireCloseNotify,
    ...(tls.sessionResumptionPolicy !== undefined && {
      tlsSessionResumptionPolicy: toNativeResumptionPolicy(tls.sessionResumptionPolicy),
    }),
    tlsSessionCachePartitionPolicy: tls.sessionCachePartitionPolicy,
  };
}

/** Flattens the public session options into the native shape. */
function toNativeSessionOptions(options: SessionOptions): NativeSessionOptions {
  const redirect = options.redirect ?? "follow";
  return {
    followRedirects: redirect !== "manual",
    // `"error"` follows no redirect at all, so the first one fails.
    maxRedirects: redirect === "error" ? 0 : options.maxRedirects,
    ...(options.acceptEncoding !== undefined && { acceptEncoding: [...options.acceptEncoding] }),
    maxConnections: options.maxConnections,
    idleTimeout: options.idleTimeout,
    ...(options.headerOrder !== undefined && { headerOrder: [...options.headerOrder] }),
    ...(options.cookieOrder !== undefined && { cookieOrder: [...options.cookieOrder] }),
    ...(options.h3HeaderOrder !== undefined && { h3HeaderOrder: [...options.h3HeaderOrder] }),
    preferredHttpVersion: options.preferredHttpVersion,
    ...(options.protocolPolicy !== undefined && {
      protocolPolicy: toNativeProtocolPolicy(options.protocolPolicy),
    }),
    httpIntent: options.httpIntent,
    ...(options.brokenQuicPolicy !== undefined && {
      brokenQuicPolicy: toNativeBrokenQuicPolicy(options.brokenQuicPolicy),
    }),
    h3RetryMode: options.h3RetryMode,
    httpsOnly: options.httpsOnly,
    ...(options.networkPartitionContext !== undefined && {
      networkPartitionContext: { ...options.networkPartitionContext },
    }),
    ech: options.ech,
    ...(options.retry !== undefined && toNativeRetry(options.retry)),
  };
}

/** Passes a retry strategy along, or wraps a retry function for the native callback bridge. */
function toNativeRetry(
  retry: RetryStrategy | RetryFunction,
): Pick<NativeSessionOptions, "retry" | "retryFn"> {
  if (typeof retry !== "function") {
    return { retry: { ...retry } };
  }
  return {
    retryFn: async (attempt, error, status) => {
      const delay = await retry({
        attempt,
        // Retried attempts fail only with request errors.
        ...(error && { error: fromNativeError(error, {}) as RequestError }),
        ...(status !== null && { status }),
      });
      return delay ?? null;
    },
  };
}

/** Wraps a single value in a list; a list is copied. */
function asList<T>(value: T | readonly T[]): T[] {
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}
