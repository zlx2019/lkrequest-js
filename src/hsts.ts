import type { NativeHsts } from "../native/index.cjs";
import { native } from "./internal/native.js";

/** A policy of your own, given to {@link Hsts.custom}. */
export interface CustomHsts {
  /**
   * Whether a request to `host` (a lower-case name, no port) must be upgraded to `https://`.
   * Called for `http://` URLs only, redirects included. It must return a boolean without
   * waiting: anything else, or an exception, counts as `false` and is logged. The client
   * waits for it, so keep it fast.
   */
  shouldUpgrade(host: string): boolean;
  /**
   * Called with the `Strict-Transport-Security` header of an HTTPS response from `host`, which
   * upstream has already checked against RFC 6797 §8.1. Optional: a policy that only looks
   * hosts up never learns any. May return a Promise, which is waited for; an exception is logged.
   */
  recordSts?(host: string, header: string): void | Promise<void>;
}

/**
 * Which `http://` hosts a session upgrades to `https://` before connecting (RFC 6797). Host
 * matching covers subdomains, as `includeSubDomains` does.
 *
 * A policy object is shared, not copied: a dynamic policy given to several sessions learns
 * `Strict-Transport-Security` hosts for all of them, like one browser profile.
 *
 * @example
 * ```ts
 * const hsts = Hsts.dynamic(["example.com"]);
 * const session = client.session({ hsts });
 * await session.get("http://example.com/"); // sent as https://example.com/
 * ```
 */
export class Hsts {
  readonly #native: NativeHsts;
  readonly #custom: CustomHsts | undefined;

  /** Policies come from the static factories. */
  private constructor(nativeHsts: NativeHsts, custom?: CustomHsts) {
    this.#native = nativeHsts;
    this.#custom = custom;
  }

  /** Never upgrades, which is what a session does without a policy. */
  static none(): Hsts {
    return new Hsts(native.NativeHsts.none());
  }

  /**
   * Upgrades a fixed set of hosts. With `preloadedTlds`, also every host under a top-level
   * domain Chrome preloads in full (`.dev`, `.app`, ...).
   */
  static static(hosts: Iterable<string>, options: { preloadedTlds?: boolean } = {}): Hsts {
    return new Hsts(native.NativeHsts.static([...hosts], options.preloadedTlds));
  }

  /**
   * Learns hosts from `Strict-Transport-Security` response headers, starting from `seed`,
   * the hosts already known to use HSTS.
   */
  static dynamic(seed: Iterable<string> = []): Hsts {
    return new Hsts(native.NativeHsts.dynamic([...seed]));
  }

  /**
   * A policy of your own. It is called on the main thread while requests wait for it, shared
   * by every session it is given to, and keeps whatever state it holds.
   *
   * @example
   * ```ts
   * const seen = new Set<string>();
   * const hsts = Hsts.custom({
   *   shouldUpgrade: (host) => seen.has(host),
   *   recordSts: (host) => void seen.add(host),
   * });
   * ```
   */
  static custom(policy: CustomHsts): Hsts {
    const shouldUpgrade = async (host: string): Promise<boolean> => {
      const upgrade: unknown = policy.shouldUpgrade(host);
      if (typeof upgrade !== "boolean") {
        throw new TypeError(
          `Hsts.custom shouldUpgrade must return a boolean, not ${typeof upgrade}`,
        );
      }
      return upgrade;
    };
    const recordSts = policy.recordSts
      ? async (host: string, header: string): Promise<void> => {
          await policy.recordSts?.(host, header);
        }
      : undefined;
    return new Hsts(native.NativeHsts.custom(shouldUpgrade, recordSts), policy);
  }

  /**
   * Whether a request to `host` would be upgraded to `https://`. With a policy of your own this
   * calls its `shouldUpgrade` and passes its exception on.
   */
  shouldUpgrade(host: string): boolean {
    // A policy in JavaScript cannot be asked through the native layer from this thread.
    return this.#custom
      ? this.#custom.shouldUpgrade(host) === true
      : this.#native.shouldUpgrade(host);
  }

  /** @internal The native policy, for the session builder. */
  static toNative(hsts: Hsts): NativeHsts {
    return hsts.#native;
  }
}
