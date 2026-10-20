import type {
  NativeBadProxyOptions,
  NativeHealthCheckOptions,
  NativeProxyConfig,
  NativeProxyLease,
  NativeProxyPool,
  NativeProxyPoolOptions,
  NativeProxySlot,
} from "../native/index.cjs";
import { Client } from "./client.js";
import { abortable } from "./internal/abort.js";
import { toNativeMasqueOptions } from "./internal/masque.js";
import { native } from "./internal/native.js";
import { callNative, fromNativeError, invalidConfig } from "./internal/native-error.js";
import type { MasqueOptions } from "./types.js";

/** Where and how a proxy is probed by {@link ProxyConfig.healthCheck}. */
export interface ProxyProbeOptions {
  /** Host to tunnel to through the proxy (default `"www.google.com"`). */
  readonly host?: string;
  /** Port to tunnel to (default 443). */
  readonly port?: number;
  /** Time limit of the check, in milliseconds (default 5000). */
  readonly timeout?: number;
  /**
   * Resolves names with this client's DNS settings and address family instead of the system
   * resolver. Names are resolved by the client for the proxy's own address, and also for the
   * target when the proxy is `socks5://` (`socks5h://` and HTTP proxies resolve it themselves).
   */
  readonly client?: Client;
}

/** A credential computed by your own code, given to {@link ProxyConfig.withCustomAuth}. */
export interface CustomProxyAuth {
  /**
   * A stable string that tells this credential apart from others on the same proxy address.
   * It becomes part of {@link ProxyConfig.identity}, which pools key their failure counts on,
   * so it must not hold a secret. Two credentials with the same identity share one key.
   */
  readonly identity: string;
  /**
   * The value of the authorization header, such as `"Bearer abc"` or a Digest response, or
   * `null` / `undefined` to send no credential. It may be async and runs on the main thread
   * while the connection waits, so keep it fast. Called whenever a connection to the proxy is
   * made, and possibly more than once per connection: do not make it hand out one-time tokens
   * as a side effect. An exception sends no credential and is logged.
   */
  authorize(): string | null | undefined | Promise<string | null | undefined>;
}

/**
 * A proxy, or a chain of proxies, to route requests through. Immutable: the `with*` methods
 * and `through()` return new configurations. Wherever a `ProxyConfig` is accepted, a proxy
 * URL string is too.
 *
 * Supported schemes are `http://` (HTTP `CONNECT`), `socks5://` (the client resolves the
 * target), `socks5h://` (the proxy resolves it) and `masque://` (MASQUE, HTTP/3 only).
 *
 * @example
 * ```ts
 * const proxy = ProxyConfig.parse("socks5h://127.0.0.1:1080").withUserPass("user", "secret");
 * const session = client.session({ proxy });
 * ```
 */
export class ProxyConfig {
  readonly #native: NativeProxyConfig;

  /** Configurations come from `ProxyConfig.parse()` and `ProxyConfig.chain()`. */
  private constructor(nativeConfig: NativeProxyConfig) {
    this.#native = nativeConfig;
  }

  /** Parses one proxy URL; credentials may be in it (`http://user:pw@host:port`). */
  static parse(url: string): ProxyConfig {
    return new ProxyConfig(callNative(() => native.NativeProxyConfig.parse(url)));
  }

  /** A chain of proxies, from the one the client connects to through to the last hop. */
  static chain(urls: Iterable<string>): ProxyConfig {
    return new ProxyConfig(callNative(() => native.NativeProxyConfig.parseChain([...urls])));
  }

  /** @internal The native configuration of a URL or a `ProxyConfig`. */
  static toNative(proxy: string | ProxyConfig): NativeProxyConfig {
    return (typeof proxy === "string" ? ProxyConfig.parse(proxy) : proxy).#native;
  }

  /** @internal Wraps a native configuration. */
  static fromNative(nativeConfig: NativeProxyConfig): ProxyConfig {
    return new ProxyConfig(nativeConfig);
  }

  /** Number of hops: 1 for a single proxy. */
  get hopCount(): number {
    return this.#native.hopCount;
  }

  /** Host of the proxy the client talks to last: the only one, or the final hop of a chain. */
  get host(): string {
    return this.#native.host;
  }

  /** Port of the proxy the client talks to last. */
  get port(): number {
    return this.#native.port;
  }

  /**
   * Whether a failure on this route never falls back to a direct connection, whatever
   * `fallback.proxyToDirect` says. True for MASQUE proxies, which exist to hide the client's
   * address: connecting directly after a tunnel fails would give it away.
   */
  get forbidsDirectFallback(): boolean {
    return this.#native.forbidsDirectFallback;
  }

  /**
   * A stable key for this route, used by the pools to track failures. It includes user names
   * but never passwords; treat it as opaque.
   */
  get identity(): string {
    return this.#native.identity;
  }

  /** A copy reached through `hops` first: `hops[0]`, ..., the last hop, then this proxy. */
  through(hops: Iterable<string | ProxyConfig>): ProxyConfig {
    const nativeHops = Array.from(hops, (hop) => ProxyConfig.toNative(hop));
    return new ProxyConfig(this.#native.through(nativeHops));
  }

  /** A copy that authenticates with a user name and password, replacing any credential. */
  withUserPass(username: string, password: string): ProxyConfig {
    return new ProxyConfig(callNative(() => this.#native.withUserPass(username, password)));
  }

  /**
   * A copy that sends `<scheme> <credentials>` (for example `Bearer` and a token, already
   * encoded) in an HTTP header, replacing any credential. Not available for SOCKS5 proxies.
   */
  withHttpAuth(scheme: string, credentials: string): ProxyConfig {
    return new ProxyConfig(callNative(() => this.#native.withHttpAuth(scheme, credentials)));
  }

  /**
   * A copy whose credential comes from `auth.authorize()`, called on every connection, for
   * schemes that cannot be written down in advance (Digest, one-time tokens). It replaces any
   * other credential. Only HTTP proxies and MASQUE proxies can carry it; a SOCKS5 proxy cannot
   * and throws `TypeError`. Use {@link ProxyConfig.withAuthHeader} to pick the header.
   *
   * @example
   * ```ts
   * const proxy = ProxyConfig.parse("http://proxy.example:8080").withCustomAuth({
   *   identity: "signed-by-kms",
   *   authorize: async () => `Bearer ${await mintToken()}`,
   * });
   * ```
   */
  withCustomAuth(auth: CustomProxyAuth): ProxyConfig {
    const authorize = async (): Promise<string | null | undefined> => auth.authorize();
    return new ProxyConfig(callNative(() => this.#native.withCustomAuth(auth.identity, authorize)));
  }

  /**
   * A copy that sends the HTTP credential in `Authorization` instead of the default
   * `Proxy-Authorization`; some MASQUE deployments expect it there.
   */
  withAuthHeader(header: "proxy-authorization" | "authorization"): ProxyConfig {
    return new ProxyConfig(callNative(() => this.#native.withAuthHeader(header)));
  }

  /**
   * Opens a tunnel to a target through the proxy and closes it again, to find out whether the
   * proxy works. Resolves with the time the tunnel took to open, in milliseconds. Rejects with
   * a `ProxyError` when the tunnel cannot be opened (the proxy cannot be reached, refuses, or
   * cannot reach the target) and with a `TimeoutError` when it takes longer than `timeout`.
   *
   * This proves a TCP tunnel only: it works for HTTP and SOCKS5 proxies and chains of them.
   * A MASQUE proxy relays UDP and always fails here; use `healthCheck.tunnelProbe` of a pool.
   */
  async healthCheck(options: ProxyProbeOptions = {}): Promise<number> {
    const { client, ...target } = options;
    const nativeClient = client === undefined ? undefined : Client.toNative(client);
    const outcome = await callNative(() => this.#native.healthCheck(target, nativeClient));
    if (outcome.error) {
      throw fromNativeError(outcome.error, {});
    }
    return outcome.latency ?? 0;
  }

  /** The proxy endpoint, without secrets. */
  toString(): string {
    return this.#native.toString();
  }
}

/** How a pool rotates through its proxies. */
export type ProxyRotation = "round_robin" | "random";

/** How a pool detects failing proxies and cools them down; durations in milliseconds. */
export interface BadProxyOptions {
  /** Failures within `window` that make a proxy bad (default 3). */
  readonly failureThreshold?: number;
  /** Window failures are counted in (default 60000). */
  readonly window?: number;
  /** How long a bad proxy is skipped (default 300000). */
  readonly cooldown?: number;
  /** Cooldowns after which a proxy is dropped for good (default 5). */
  readonly maxCooldowns?: number;
}

/** Periodic health checks of a pool's proxies; durations in milliseconds. */
export interface HealthCheckOptions {
  /** Time between checks (default 60000). */
  readonly interval?: number;
  /** Time limit of one check (default 5000). */
  readonly timeout?: number;
  /** Host each check connects to through the proxy (default `"www.google.com"`). */
  readonly targetHost?: string;
  /** Port each check connects to (default 443). */
  readonly targetPort?: number;
  /**
   * A plain check only proves a TCP connect, which says nothing about a MASQUE proxy, so those
   * are skipped by default (neither credited nor blacklisted). `true` opens a real CONNECT-UDP
   * tunnel to the target instead, reaching the proxy as `masque` describes, which is then
   * required.
   */
  readonly tunnelProbe?: boolean;
  /** How to reach MASQUE proxies for `tunnelProbe`. */
  readonly masque?: MasqueOptions;
}

/** Makes up the proxy for one lease, such as a residential gateway with a fresh session id. */
export type ProxyFactory = () => string | ProxyConfig | Promise<string | ProxyConfig>;

/**
 * Where a pool's proxies come from: a list, or a function called for every lease (or session)
 * that returns a proxy URL or a {@link ProxyConfig}, which can be a chain or carry a custom
 * credential.
 *
 * A function suits endpoints that hand out a new identity per request. Pools do not keep
 * failure counts for such proxies, so `rotation`, `badProxy` and `healthCheck` do not apply to
 * them, and `markBad()` only makes a session pool discard the session. When the function
 * throws, takes longer than 30 seconds or returns something that is not a proxy, the pool asks
 * it again about every 100 milliseconds, so `acquire()` waits until it gives a proxy (pass a
 * `signal` to stop waiting): a pool never hands out a lease without a proxy for it.
 */
export type ProxySource = Iterable<string | ProxyConfig> | ProxyFactory;

/** Options of a pool's `acquire()` and `acquireFresh()`. */
export interface AcquireOptions {
  /** Stops waiting: the call rejects with an `AbortError` and takes no permit. */
  readonly signal?: AbortSignal;
}

/** Options of a {@link ProxyPool}. */
export interface ProxyPoolOptions {
  /** Most proxies leased out at once (default 100); `acquire()` waits when all are taken. */
  readonly maxConcurrent?: number;
  /** Rotation strategy (default `"round_robin"`). */
  readonly rotation?: ProxyRotation;
  /** Bad-proxy detection and cooldown. */
  readonly badProxy?: BadProxyOptions;
  /** Periodic health checks, run in the background. */
  readonly healthCheck?: HealthCheckOptions;
  /**
   * With a proxy function, how many proxies to make up ahead of time, in the background, so
   * `acquire()` rarely waits for the function. The function may then run before it is needed,
   * and proxies made for a pool that is never used again are wasted.
   */
  readonly proxyBuffer?: number;
}

/**
 * A pool of proxies handed out in rotation, skipping the ones marked bad.
 *
 * Proxies that are cooling down (see `badProxy`) are skipped. While all of them are,
 * `acquire()` waits until one recovers, and once every proxy has been dropped for good it waits
 * forever: pass a `signal` to stop waiting. Only a pool without proxies leases none.
 *
 * @example
 * ```ts
 * const pool = new ProxyPool(["http://p1:8080", "http://p2:8080"]);
 * using lease = await pool.acquire();
 * const res = await client.session({ proxy: lease.proxy }).get(url);
 * ```
 */
export class ProxyPool {
  readonly #native: NativeProxyPool;

  /** Builds a pool; an invalid proxy or option throws `TypeError` (`ERR_LK_INVALID_CONFIG`). */
  constructor(proxies: ProxySource, options: ProxyPoolOptions = {}) {
    const nativeOptions = toNativeProxyPoolOptions(options);
    if (typeof proxies === "function") {
      assertFunctionSource(options);
      const factory = toNativeFactory(proxies);
      this.#native = callNative(() => native.NativeProxyPool.fromFactory(factory, nativeOptions));
    } else {
      assertListSource(options);
      const nativeProxies = Array.from(proxies, (proxy) => ProxyConfig.toNative(proxy));
      this.#native = callNative(() => new native.NativeProxyPool(nativeProxies, nativeOptions));
    }
  }

  /** Most proxies that can be leased out at once. */
  get maxConcurrent(): number {
    return this.#native.maxConcurrent;
  }

  /**
   * Waits for a free proxy permit and leases the next usable proxy, waiting too while there is
   * none. Rejects with an `AbortError` when `signal` aborts first.
   */
  async acquire(options: AcquireOptions = {}): Promise<ProxyLease> {
    const lease = await abortable(options.signal, (handle) => this.#native.acquire(handle));
    return ProxyLease.fromNative(lease);
  }

  /**
   * Gives up a lease whose proxy failed: marks the proxy bad, releases the lease, and leases the
   * next proxy as `acquire()` does. The lease is released first, so this works with a single
   * slot.
   */
  async acquireFresh(bad: ProxyLease, options: AcquireOptions = {}): Promise<ProxyLease> {
    const lease = await abortable(options.signal, (handle) =>
      this.#native.acquireFresh(ProxyLease.toNative(bad), handle),
    );
    return ProxyLease.fromNative(lease);
  }

  /**
   * Marks the proxy with this identity (see `ProxyConfig#identity`) as failing, so the pool
   * cools it down once the failure threshold is reached.
   */
  markBad(identity: string): void {
    this.#native.markBad(identity);
  }
}

/** A proxy leased from a {@link ProxyPool}; it holds a pool permit until released. */
export class ProxyLease {
  /** The leased proxy, or `null` when the pool has no proxies. */
  readonly proxy: ProxyConfig | null;
  readonly #native: NativeProxyLease;

  /** Leases come from `ProxyPool#acquire()`. */
  private constructor(nativeLease: NativeProxyLease) {
    this.#native = nativeLease;
    const proxy = nativeLease.proxy;
    this.proxy = proxy ? ProxyConfig.fromNative(proxy) : null;
  }

  /** @internal Wraps a native lease. */
  static fromNative(nativeLease: NativeProxyLease): ProxyLease {
    return new ProxyLease(nativeLease);
  }

  /** @internal The native lease. */
  static toNative(lease: ProxyLease): NativeProxyLease {
    return lease.#native;
  }

  /**
   * Reports the leased proxy as failing, so the pool cools it down once the failure threshold
   * is reached.
   */
  markBad(): void {
    this.#native.markBad();
  }

  /** Gives the permit back to the pool; calling it again does nothing. */
  release(): void {
    this.#native.release();
  }

  /** Releases the lease, for `using`. */
  [Symbol.dispose](): void {
    this.release();
  }
}

/** @internal Refuses the options that make no sense for a pool whose proxies a function makes. */
export function assertFunctionSource(options: {
  readonly rotation?: unknown;
  readonly badProxy?: unknown;
  readonly healthCheck?: unknown;
}): void {
  for (const name of ["rotation", "badProxy", "healthCheck"] as const) {
    if (options[name] !== undefined) {
      throw invalidConfig(`${name} does not apply to proxies made up by a function`);
    }
  }
}

/** @internal Refuses `proxyBuffer`, which only a proxy function can use. */
export function assertListSource(options: { readonly proxyBuffer?: unknown }): void {
  if (options.proxyBuffer !== undefined) {
    throw invalidConfig("proxyBuffer only applies to proxies made up by a function");
  }
}

/** @internal Wraps a proxy function into one that leaves its proxy in the slot it is given. */
export function toNativeFactory(factory: ProxyFactory): (slot: NativeProxySlot) => Promise<void> {
  return async (slot) => {
    const proxy: unknown = await factory();
    if (typeof proxy === "string") {
      slot.setUrl(proxy);
    } else if (proxy instanceof ProxyConfig) {
      slot.setConfig(ProxyConfig.toNative(proxy));
    } else {
      throw new TypeError("the proxy function must return a proxy URL or a ProxyConfig");
    }
  };
}

/** Flattens the pool options into the native shape. */
function toNativeProxyPoolOptions(options: ProxyPoolOptions): NativeProxyPoolOptions {
  return {
    maxConcurrent: options.maxConcurrent,
    rotation: options.rotation,
    proxyBuffer: options.proxyBuffer,
    ...(options.badProxy !== undefined && { badProxy: toNativeBadProxy(options.badProxy) }),
    ...(options.healthCheck !== undefined && {
      healthCheck: toNativeHealthCheck(options.healthCheck),
    }),
  };
}

/** @internal The native shape of bad-proxy detection settings. */
export function toNativeBadProxy(options: BadProxyOptions): NativeBadProxyOptions {
  return { ...options };
}

/** @internal The native shape of health-check settings; the MASQUE options are flattened. */
export function toNativeHealthCheck(options: HealthCheckOptions): NativeHealthCheckOptions {
  return {
    ...options,
    masque: options.masque === undefined ? undefined : toNativeMasqueOptions(options.masque),
  };
}
