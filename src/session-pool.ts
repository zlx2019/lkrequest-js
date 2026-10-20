import type { NativeSessionLease, NativeSessionPool } from "../native/index.cjs";
import { Client } from "./client.js";
import { abortable } from "./internal/abort.js";
import { Hooks } from "./internal/interceptors.js";
import { native } from "./internal/native.js";
import { callNative } from "./internal/native-error.js";
import {
  type AcquireOptions,
  assertFunctionSource,
  assertListSource,
  type BadProxyOptions,
  type HealthCheckOptions,
  ProxyConfig,
  type ProxyRotation,
  type ProxySource,
  toNativeBadProxy,
  toNativeFactory,
  toNativeHealthCheck,
} from "./proxy.js";
import { Session } from "./session.js";

/** Options of a {@link SessionPool}. */
export interface SessionPoolOptions {
  /**
   * The proxies sessions are bound to, one proxy per session: a list, or a function that makes
   * one up per new session (see {@link ProxySource}). Without any, sessions connect directly.
   */
  readonly proxies?: ProxySource;
  /** Largest number of sessions alive at once. */
  readonly maxSessions?: number;
  /** How long an idle session is kept, in milliseconds. */
  readonly idleTimeout?: number;
  /** Rotation over the proxies (default `"round_robin"`). */
  readonly rotation?: ProxyRotation;
  /** Bad-proxy detection and cooldown. */
  readonly badProxy?: BadProxyOptions;
  /** Periodic health checks of the proxies, run in the background. */
  readonly healthCheck?: HealthCheckOptions;
  /**
   * With a proxy function, how many proxies to make up ahead of time, in the background, so
   * `acquire()` rarely waits for the function.
   */
  readonly proxyBuffer?: number;
}

/** Session pool statistics. */
export interface SessionPoolStats {
  /** Sessions waiting to be leased again. */
  readonly idleSessions: number;
  /** Largest number of sessions alive at once. */
  readonly maxSessions: number;
}

/**
 * A pool of a client's sessions, each bound to one of the pool's proxies. Leased sessions
 * keep their cookies and connections when they go back to the pool.
 *
 * A pool with proxies never hands out a session without one. While all of its proxies are
 * cooling down (see `badProxy`), `acquire()` waits until one recovers, and once every proxy
 * has been dropped for good it waits forever: pass a `signal` to stop waiting.
 *
 * @example
 * ```ts
 * const pool = new SessionPool(client, { proxies: ["http://p1:8080", "http://p2:8080"] });
 * {
 *   using lease = await pool.acquire();
 *   await lease.session.get("https://example.com");
 * } // returned to the pool here
 * ```
 */
export class SessionPool {
  readonly #native: NativeSessionPool;
  readonly #client: Client;

  /** Builds a pool; an invalid proxy or option throws `TypeError` (`ERR_LK_INVALID_CONFIG`). */
  constructor(client: Client, options: SessionPoolOptions = {}) {
    const nativeOptions = {
      maxSessions: options.maxSessions,
      idleTimeout: options.idleTimeout,
      rotation: options.rotation,
      proxyBuffer: options.proxyBuffer,
      ...(options.badProxy !== undefined && { badProxy: toNativeBadProxy(options.badProxy) }),
      ...(options.healthCheck !== undefined && {
        healthCheck: toNativeHealthCheck(options.healthCheck),
      }),
    };
    const nativeClient = Client.toNative(client);
    if (typeof options.proxies === "function") {
      assertFunctionSource(options);
      const factory = toNativeFactory(options.proxies);
      this.#native = callNative(() =>
        native.NativeSessionPool.fromFactory(nativeClient, factory, nativeOptions),
      );
    } else {
      assertListSource(options);
      const proxies = Array.from(options.proxies ?? [], (proxy) => ProxyConfig.toNative(proxy));
      this.#native = callNative(
        () => new native.NativeSessionPool(nativeClient, proxies, nativeOptions),
      );
    }
    this.#client = client;
  }

  /**
   * Waits for a free session and leases it, waiting too while no proxy is usable. Rejects with
   * an `AbortError` when `signal` aborts first.
   */
  async acquire(options: AcquireOptions = {}): Promise<SessionLease> {
    const lease = await abortable(options.signal, (handle) => this.#native.acquire(handle));
    return SessionLease.fromNative(lease, this.#client);
  }

  /**
   * Gives up a lease whose session failed: marks its proxy bad, discards the session, and
   * leases another one as `acquire()` does.
   */
  async acquireFresh(bad: SessionLease, options: AcquireOptions = {}): Promise<SessionLease> {
    const lease = await abortable(options.signal, (handle) =>
      this.#native.acquireFresh(SessionLease.toNative(bad), handle),
    );
    return SessionLease.fromNative(lease, this.#client);
  }

  /** Current pool statistics. */
  async stats(): Promise<SessionPoolStats> {
    return this.#native.stats();
  }
}

/**
 * A session leased from a {@link SessionPool}. Release it (or let `using` do so) to return
 * the session; a lease that is garbage collected unreleased is returned too.
 */
export class SessionLease {
  /** The leased session; it runs the client's middleware. */
  readonly session: Session;
  readonly #native: NativeSessionLease;

  /** Leases come from `SessionPool#acquire()`. */
  private constructor(nativeLease: NativeSessionLease, client: Client) {
    this.#native = nativeLease;
    this.session = Session.fromNative(nativeLease.session(), {
      baseUrl: undefined,
      middleware: Client.middlewareOf(client),
      hooks: new Hooks(),
    });
  }

  /** @internal Wraps a native lease. */
  static fromNative(nativeLease: NativeSessionLease, client: Client): SessionLease {
    return new SessionLease(nativeLease, client);
  }

  /** @internal The native lease. */
  static toNative(lease: SessionLease): NativeSessionLease {
    return lease.#native;
  }

  /**
   * Reports the session's proxy as failing. The session is then discarded on release instead
   * of going back to the pool.
   */
  markBad(): void {
    this.#native.markBad();
  }

  /** Returns the session to the pool; calling it again does nothing. */
  release(): void {
    this.#native.release();
  }

  /** Releases the lease, for `using`. */
  [Symbol.dispose](): void {
    this.release();
  }
}
