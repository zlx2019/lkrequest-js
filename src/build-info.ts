import { native } from "./internal/native.js";

/** Optional capabilities compiled into the native addon. */
export interface Features {
  /** QUIC and HTTP/3 support. */
  readonly quicH3: boolean;
  /** MASQUE (RFC 9298 CONNECT-UDP) proxies. */
  readonly masque: boolean;
  /** Built-in DNS-over-HTTPS resolvers. */
  readonly doh: boolean;
  /** Wire-level telemetry counters reported by the metrics snapshot. */
  readonly telemetry: boolean;
  /** Synthetic fingerprint randomization, which matches no real browser. */
  readonly syntheticFp: boolean;
}

/** Browser family a preset emulates. */
export type BrowserFamily = "chrome" | "firefox" | "safari";

/** Summary of a browser preset. */
export interface PresetInfo {
  /** Canonical preset name, e.g. `chrome_155`. */
  readonly name: string;
  /** Browser family the preset emulates. */
  readonly browser: BrowserFamily;
  /** Whether the preset carries a QUIC/HTTP3 fingerprint in this build. */
  readonly http3: boolean;
}

/** Version of this package, which always equals the version of its native addon. */
export const version: string = native.version();

/**
 * Reports which optional capabilities this build supports.
 *
 * Published packages enable every capability; a build from source may have fewer.
 */
export function features(): Features {
  return native.features();
}

/** Lists every browser preset known to this build, in a stable order. */
export function listPresets(): PresetInfo[] {
  return native.listPresets();
}
