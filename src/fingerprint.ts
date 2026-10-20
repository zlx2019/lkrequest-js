import type {
  NativeH2Profile,
  NativeH2ProfileOptions,
  NativeQuicProfile,
  NativeTcpFingerprint,
  NativeTcpFingerprintOptions,
  NativeTlsProfile,
  NativeTlsProfileOptions,
} from "../native/index.cjs";
import { parseExactJson } from "./internal/json.js";
import { native } from "./internal/native.js";
import { callNative } from "./internal/native-error.js";

/**
 * TLS extension code points, for `ExtensionSpec#extensionType`. The same values as upstream's
 * `lktls::profile::types::ext_type`.
 */
export const ExtensionType: Readonly<Record<string, number>> = Object.freeze({
  SNI: 0x0000,
  STATUS_REQUEST: 0x0005,
  SUPPORTED_GROUPS: 0x000a,
  EC_POINT_FORMATS: 0x000b,
  SIGNATURE_ALGORITHMS: 0x000d,
  ALPN: 0x0010,
  SIGNED_CERTIFICATE_TIMESTAMP: 0x0012,
  PADDING: 0x0015,
  ENCRYPT_THEN_MAC: 0x0016,
  EXTENDED_MASTER_SECRET: 0x0017,
  COMPRESS_CERTIFICATE: 0x001b,
  RECORD_SIZE_LIMIT: 0x001c,
  DELEGATED_CREDENTIALS: 0x0022,
  SESSION_TICKET: 0x0023,
  PRE_SHARED_KEY: 0x0029,
  EARLY_DATA: 0x002a,
  SUPPORTED_VERSIONS: 0x002b,
  COOKIE: 0x002c,
  PSK_KEY_EXCHANGE_MODES: 0x002d,
  KEY_SHARE: 0x0033,
  QUIC_TRANSPORT_PARAMETERS: 0x0039,
  APPLICATION_SETTINGS: 0x4469,
  APPLICATION_SETTINGS_NEW: 0x44cd,
  TRUST_ANCHOR_IDS: 0xca34,
  ENCRYPTED_CLIENT_HELLO: 0xfe0d,
  RENEGOTIATION_INFO: 0xff01,
});

/** A TLS protocol version. */
export type TlsVersion = "tls10" | "tls11" | "tls12" | "tls13";

/** One extension of a hand-built TLS profile. */
export interface ExtensionSpec {
  /** The extension's code point; see {@link ExtensionType}. */
  readonly extensionType: number;
  /**
   * Where the payload comes from: `"auto"` (built from the profile, the default), `"grease"`,
   * `"raw_bytes"` (`rawData`) or `"trust_anchor_ids"` (`trustAnchorIds`).
   */
  readonly source?: "auto" | "grease" | "raw_bytes" | "trust_anchor_ids";
  /** Hex payload, for `"raw_bytes"`. */
  readonly rawData?: string;
  /** Hex trust anchor identifiers, for `"trust_anchor_ids"`. */
  readonly trustAnchorIds?: readonly string[];
  /** Shuffle the trust anchor identifiers on every ClientHello. */
  readonly shuffle?: boolean;
}

/** Which ClientHello fields carry GREASE values; all off by default. */
export interface GreaseOptions {
  readonly cipherSuite?: boolean;
  readonly extensions?: boolean;
  readonly supportedGroups?: boolean;
  readonly supportedVersions?: boolean;
  readonly signatureAlgorithms?: boolean;
  readonly keyShare?: boolean;
}

/** How the ClientHello is padded. */
export type PaddingStrategy =
  | { readonly mode: "none" }
  | { readonly mode: "block_align"; readonly minLength: number; readonly blockSize: number }
  | { readonly mode: "fixed_target"; readonly targetLength: number };

/** A hand-built TLS profile; what is left out takes lkrequest-py's defaults. */
export interface TlsProfileOptions {
  /** Name, for diagnostics. */
  readonly name: string;
  /** Cipher suite code points, in order. */
  readonly cipherSuites?: readonly number[];
  /** Extensions, in order. */
  readonly extensions?: readonly ExtensionSpec[];
  /** Supported group code points. */
  readonly supportedGroups?: readonly number[];
  /** Signature algorithm code points. */
  readonly signatureAlgorithms?: readonly number[];
  /** Groups to send a key share for. */
  readonly keyShareCurves?: readonly number[];
  /** ALPN protocols (default `["h2", "http/1.1"]`). */
  readonly alpnProtocols?: readonly string[];
  /** Lowest version (default `"tls12"`). */
  readonly tlsMinVersion?: TlsVersion;
  /** Highest version (default `"tls13"`). */
  readonly tlsMaxVersion?: TlsVersion;
  /** EC point formats (default `[0]`). */
  readonly ecPointFormats?: readonly number[];
  /** Compression methods (default `[0]`). */
  readonly compressionMethods?: readonly number[];
  /** GREASE switches. */
  readonly grease?: GreaseOptions;
  /** ClientHello padding (default none). */
  readonly padding?: PaddingStrategy;
  /** ALPS protocols. */
  readonly alpsProtocols?: readonly string[];
  /** Certificate compression algorithm code points. */
  readonly compressCertAlgorithms?: readonly number[];
  /** Record size limit extension value. */
  readonly recordSizeLimit?: number;
  /** Signature algorithms of the delegated credentials extension. */
  readonly delegatedCredentialsSigAlgs?: readonly number[];
  /** Session ID length (default 32). */
  readonly sessionIdLength?: number;
  /** Shuffle the extension order on every connection. */
  readonly shuffleExtensions?: boolean;
}

/**
 * A TLS fingerprint: the ClientHello a client sends. Build one from a preset, by hand, from
 * JSON (upstream's format, shared with lkrequest-py) or from a captured ClientHello, and pass
 * it as `tlsProfile` (or `quicFingerprint`) to a `Client`.
 *
 * @example
 * ```ts
 * const tlsProfile = TlsProfile.preset("chrome_155");
 * const client = new Client({ tlsProfile, h2Profile: "chrome_155" });
 * ```
 */
export class TlsProfile {
  readonly #native: NativeTlsProfile;

  /** Profiles come from the static factories. */
  private constructor(nativeProfile: NativeTlsProfile) {
    this.#native = nativeProfile;
  }

  /**
   * A preset by name: `chrome_131` to `chrome_155`, the QUIC ClientHellos `chrome_146_quic`
   * to `chrome_155_quic`, `firefox_133`, `firefox_147`, `firefox_156`, `safari_18`,
   * `safari_26`.
   */
  static preset(name: string): TlsProfile {
    return new TlsProfile(callNative(() => native.NativeTlsProfile.preset(name)));
  }

  /** The names `preset()` accepts. */
  static presetNames(): string[] {
    return native.NativeTlsProfile.presetNames();
  }

  /** A hand-built profile. */
  static create(options: TlsProfileOptions): TlsProfile {
    const nativeOptions = toNativeTlsOptions(options);
    return new TlsProfile(callNative(() => native.NativeTlsProfile.create(nativeOptions)));
  }

  /** A profile from its JSON form, as a string or a parsed object. */
  static fromJSON(json: string | object): TlsProfile {
    const text = typeof json === "string" ? json : JSON.stringify(json);
    return new TlsProfile(callNative(() => native.NativeTlsProfile.fromJson(text)));
  }

  /** A profile rebuilt from captured ClientHello bytes, with or without the record header. */
  static fromClientHello(data: Uint8Array, options: { readonly name?: string } = {}): TlsProfile {
    return new TlsProfile(
      callNative(() => native.NativeTlsProfile.fromClientHello(data, options.name)),
    );
  }

  /** @internal The native profile. */
  static toNative(profile: string | TlsProfile): NativeTlsProfile {
    return (typeof profile === "string" ? TlsProfile.preset(profile) : profile).#native;
  }

  /** @internal Wraps a native profile. */
  static fromNative(nativeProfile: NativeTlsProfile): TlsProfile {
    return new TlsProfile(nativeProfile);
  }

  /** Profile name. */
  get name(): string {
    return this.#native.name;
  }

  /** Cipher suite code points. */
  get cipherSuites(): number[] {
    return this.#native.cipherSuites;
  }

  /** Supported group code points. */
  get supportedGroups(): number[] {
    return this.#native.supportedGroups;
  }

  /** Signature algorithm code points. */
  get signatureAlgorithms(): number[] {
    return this.#native.signatureAlgorithms;
  }

  /** ALPN protocols. */
  get alpnProtocols(): string[] {
    return this.#native.alpnProtocols;
  }

  /** @internal A copy whose extension order is shuffled per connection, or not. */
  withShuffledExtensions(shuffle: boolean): TlsProfile {
    return new TlsProfile(this.#native.withShuffledExtensions(shuffle));
  }

  /** The profile in upstream's JSON format, as a plain object (`JSON.stringify` uses it). */
  toJSON(): Record<string, unknown> {
    return JSON.parse(this.#native.toJson()) as Record<string, unknown>;
  }
}

/** One HTTP/2 SETTINGS entry: a known setting by name, or any setting by its numeric id. */
export interface H2Setting {
  readonly id:
    | "header_table_size"
    | "enable_push"
    | "max_concurrent_streams"
    | "initial_window_size"
    | "max_frame_size"
    | "max_header_list_size"
    | "enable_connect_protocol"
    | "no_rfc7540_priorities"
    | number;
  readonly value: number;
}

/** A pseudo-header, in the order an HTTP/2 profile sends them. */
export type PseudoHeader = "method" | "authority" | "scheme" | "path";

/** Priority of the HEADERS frame; `weight` is stored minus one (0 to 255). */
export interface HeadersPriority {
  readonly streamDependency: number;
  readonly weight: number;
  readonly exclusive: boolean;
}

/** A PRIORITY frame sent after the connection preface. */
export interface PriorityFrame {
  readonly streamId: number;
  readonly dependency: number;
  readonly weight: number;
  readonly exclusive: boolean;
}

/** How request priorities map onto HTTP/2, as read from a profile. */
export interface PriorityConfig {
  /** Weight per urgency 0–7. */
  readonly urgencyWeights?: readonly number[];
  readonly exclusive?: boolean;
  /**
   * What a new stream depends on: stream 0 (`flat`), the previous stream (`chain`), or, as
   * Chrome does, the newest open stream of the same or a higher priority (`priority_chain`).
   */
  readonly streamDepPolicy?: "flat" | "chain" | "priority_chain";
  /** Send a `priority` header derived from the request priority. */
  readonly autoPriorityHeader?: boolean;
  /** Urgency of requests without a priority (0–7, default 3). */
  readonly defaultUrgency?: number;
  readonly defaultIncremental?: boolean;
}

/** A hand-built HTTP/2 profile. */
export interface H2ProfileOptions {
  /** SETTINGS entries, in order. */
  readonly settings: readonly H2Setting[];
  /** Connection WINDOW_UPDATE increment. */
  readonly windowUpdate: number;
  /** Pseudo-header order. */
  readonly pseudoHeaderOrder: readonly PseudoHeader[];
  /** Priority of the HEADERS frame. */
  readonly headersPriority?: HeadersPriority;
  /** PRIORITY frames sent after the preface. */
  readonly priorityFrames?: readonly PriorityFrame[];
  /** Request priority mapping: a browser preset or the fields (default `"default"`). */
  readonly priorityConfig?:
    | "default"
    | "chrome"
    | "firefox"
    | "safari18"
    | "safari26"
    | PriorityConfig;
  /**
   * Stream id of the first request on a connection: an odd number from 1 to 2^31-1 (default
   * 1; Firefox 156 starts at 3).
   */
  readonly initialStreamId?: number;
}

/**
 * An HTTP/2 fingerprint: SETTINGS, WINDOW_UPDATE, pseudo-header order and priorities. Pass it
 * as `h2Profile` to a `Client`.
 */
export class H2Profile {
  readonly #native: NativeH2Profile;

  /** Profiles come from the static factories. */
  private constructor(nativeProfile: NativeH2Profile) {
    this.#native = nativeProfile;
  }

  /** A preset by name: `chrome_131` to `chrome_155`, `firefox_*`, `safari_*`. */
  static preset(name: string): H2Profile {
    return new H2Profile(callNative(() => native.NativeH2Profile.preset(name)));
  }

  /** The names `preset()` accepts. */
  static presetNames(): string[] {
    return native.NativeH2Profile.presetNames();
  }

  /** A hand-built profile. */
  static create(options: H2ProfileOptions): H2Profile {
    const nativeOptions = toNativeH2Options(options);
    return new H2Profile(callNative(() => native.NativeH2Profile.create(nativeOptions)));
  }

  /** A profile from its JSON form, as a string or a parsed object. */
  static fromJSON(json: string | object): H2Profile {
    const text = typeof json === "string" ? json : JSON.stringify(json);
    return new H2Profile(callNative(() => native.NativeH2Profile.fromJson(text)));
  }

  /** A profile rebuilt from captured HTTP/2 frames, starting with the connection preface. */
  static fromH2Frames(data: Uint8Array): H2Profile {
    return new H2Profile(callNative(() => native.NativeH2Profile.fromH2Frames(data)));
  }

  /** @internal The native profile. */
  static toNative(profile: string | H2Profile): NativeH2Profile {
    return (typeof profile === "string" ? H2Profile.preset(profile) : profile).#native;
  }

  /**
   * Throws `TypeError` (`ERR_LK_INVALID_CONFIG`) when the profile breaks the structural rules
   * of HTTP/2: the four pseudo-headers must each appear once, SETTINGS ids must be unique and
   * within range (`enable_push` is 0 or 1, the initial window at most 2^31-1, the maximum frame
   * size 16384 to 16777215), and the WINDOW_UPDATE must not overflow the connection window.
   * The presets pass; a hand-built or captured profile may not.
   */
  validate(): void {
    callNative(() => this.#native.validate());
  }

  /** The request priority mapping. */
  get priorityConfig(): PriorityConfig {
    const { preset: _preset, ...config } = this.#native.priorityConfig;
    return Object.fromEntries(
      Object.entries(config).filter(([, value]) => value != null),
    ) as PriorityConfig;
  }

  /** Stream id of the first request on a connection. */
  get initialStreamId(): number {
    return this.#native.initialStreamId;
  }

  /** The profile in upstream's JSON format, as a plain object (`JSON.stringify` uses it). */
  toJSON(): Record<string, unknown> {
    return JSON.parse(this.#native.toJson()) as Record<string, unknown>;
  }
}

/** TCP keep-alive: probes sent on an idle connection; durations in milliseconds. */
export interface TcpKeepalive {
  /** Time a connection is idle before the first probe. */
  readonly idle?: number;
  /** Time between probes. */
  readonly interval?: number;
}

/**
 * A hand-built TCP fingerprint. What is left out stays at the operating system's default,
 * except Nagle's algorithm, which connections turn off unless `tcpNodelay` says otherwise.
 */
export interface TcpFingerprintOptions {
  /**
   * Target window size of the SYN (JA4T part A). With `windowScale` it sizes the receive
   * buffer, from which the kernel picks the window and its scale; alone it changes nothing.
   */
  readonly windowSize?: number;
  /** Maximum segment size (JA4T part C); applied on Linux only, elsewhere kept for `toJa4t()`. */
  readonly mss?: number;
  /** Target window scale (JA4T part D); see `windowSize`. */
  readonly windowScale?: number;
  /** IPv4 time to live, or IPv6 hop limit. */
  readonly ttl?: number;
  /** Disable Nagle's algorithm. */
  readonly tcpNodelay?: boolean;
  /**
   * Receive buffer size, instead of the one derived from `windowSize` and `windowScale`. On
   * Linux it also turns the buffer's autotuning off.
   */
  readonly recvBufSize?: number;
  /** Send buffer size. */
  readonly sendBufSize?: number;
  /**
   * TCP options in SYN order, as option kinds: 0 end of list, 1 no-op, 2 MSS, 3 window scale,
   * 4 SACK permitted, 8 timestamps (JA4T part B, for example `[2, 1, 3, 1, 1, 4]`). The
   * operating system decides which options go on the wire, so this only completes
   * {@link TcpFingerprint.toJa4t}.
   */
  readonly tcpOptions?: readonly number[];
  /** Keep-alive probes: `true` for the system's timing, or the timing itself. */
  readonly keepalive?: boolean | TcpKeepalive;
}

/**
 * A TCP fingerprint: window size, MSS, window scale, TTL and socket buffers. Pass it as
 * `tcpFingerprint` to a `Client`; a string there is a preset name or a JA4T string.
 *
 * These are socket settings that steer the SYN, which the kernel still builds, so the JA4T a
 * server sees can differ from the target. They apply to new direct connections and to the
 * connection to the first proxy; behind a proxy the server sees the proxy's own TCP stack.
 */
export class TcpFingerprint {
  readonly #native: NativeTcpFingerprint;

  /** Fingerprints come from the static factories. */
  private constructor(nativeFingerprint: NativeTcpFingerprint) {
    this.#native = nativeFingerprint;
  }

  /**
   * A preset by name: `chrome`, `chrome_win`, `chrome_linux`, `chrome_macos`, `firefox`,
   * `firefox_win`, `firefox_linux`, `firefox_macos`, `safari`, `safari_ios`, or `none` for the
   * operating system's own TCP behavior (which also clears a browser preset's fingerprint).
   */
  static preset(name: string): TcpFingerprint {
    return new TcpFingerprint(callNative(() => native.NativeTcpFingerprint.preset(name)));
  }

  /** The names `preset()` accepts. */
  static presetNames(): string[] {
    return native.NativeTcpFingerprint.presetNames();
  }

  /** A hand-built fingerprint. */
  static create(options: TcpFingerprintOptions): TcpFingerprint {
    const nativeOptions = toNativeTcpOptions(options);
    return new TcpFingerprint(callNative(() => native.NativeTcpFingerprint.create(nativeOptions)));
  }

  /** A fingerprint from a JA4T string. */
  static fromJa4t(ja4t: string): TcpFingerprint {
    return new TcpFingerprint(callNative(() => native.NativeTcpFingerprint.fromJa4T(ja4t)));
  }

  /** @internal The native fingerprint of a preset name, a JA4T string or a fingerprint. */
  static toNative(fingerprint: string | TcpFingerprint): NativeTcpFingerprint {
    if (typeof fingerprint === "string") {
      return callNative(() => native.NativeTcpFingerprint.resolve(fingerprint));
    }
    return fingerprint.#native;
  }

  /**
   * The configured target as JA4T (not what went on the wire), or `undefined` when it lacks
   * the fields for one.
   */
  toJa4t(): string | undefined {
    return this.#native.toJa4T() ?? undefined;
  }
}

/**
 * A QUIC / HTTP/3 fingerprint: transport parameters, HTTP/3 SETTINGS and packet layout. Pass it
 * as `quicProfile` to a `Client`. Needs a build with the `quic-h3` feature (release builds have
 * it).
 */
export class QuicProfile {
  readonly #native: NativeQuicProfile;

  /** Profiles come from the static factories. */
  private constructor(nativeProfile: NativeQuicProfile) {
    this.#native = nativeProfile;
  }

  /** A preset by name: `chrome`, `chrome_146`, `chrome_150` to `chrome_155`. */
  static preset(name: string): QuicProfile {
    return new QuicProfile(callNative(() => native.NativeQuicProfile.preset(name)));
  }

  /** The names `preset()` accepts. */
  static presetNames(): string[] {
    return native.NativeQuicProfile.presetNames();
  }

  /** A profile from its JSON form, as a string or a parsed object. */
  static fromJSON(json: string | object): QuicProfile {
    const text = typeof json === "string" ? json : JSON.stringify(json);
    return new QuicProfile(callNative(() => native.NativeQuicProfile.fromJson(text)));
  }

  /** @internal The native profile. */
  static toNative(profile: string | QuicProfile): NativeQuicProfile {
    return (typeof profile === "string" ? QuicProfile.preset(profile) : profile).#native;
  }

  /** Length of the connection IDs the client chooses. */
  get connectionIdLength(): number {
    return this.#native.connectionIdLength;
  }

  /** Throws `TypeError` (`ERR_LK_INVALID_CONFIG`) when the settings contradict each other. */
  validate(): void {
    callNative(() => this.#native.validate());
  }

  /**
   * The profile in upstream's JSON format, as a plain object (`JSON.stringify` uses it).
   * Integers beyond `Number.MAX_SAFE_INTEGER`, such as some transport parameter ids, are
   * `JSON.rawJSON()` values, so they come back exact from `fromJSON()`.
   */
  toJSON(): Record<string, unknown> {
    return parseExactJson(this.#native.toJson());
  }
}

/** One frame of an HTTP/3 control stream. */
export interface H3ControlFrame {
  /** Frame type, such as `0x4n` for SETTINGS. */
  readonly frameType: bigint;
  /** Frame payload. */
  readonly payload: Uint8Array;
}

/** One HTTP/3 SETTINGS entry. */
export interface H3Setting {
  readonly id: bigint;
  readonly value: bigint;
}

/** An HTTP/3 PRIORITY_UPDATE frame (RFC 9218). */
export interface H3PriorityUpdate {
  /** `0xf0700n` for a request stream, `0xf0701n` for a push. */
  readonly frameType: bigint;
  /** The stream or push whose priority is updated. */
  readonly elementId: bigint;
  /** The priority field value as sent, such as `"u=0, i"`, one character per byte. */
  readonly fieldValue: string;
}

/** What a client sent on its HTTP/3 control stream. */
export interface H3ControlStream {
  /** Every frame, in order, unknown types included. */
  readonly frames: readonly H3ControlFrame[];
  /** SETTINGS entries in the order sent, unknown and repeated ids included. */
  readonly settings: readonly H3Setting[];
  /** PRIORITY_UPDATE frames, in order. */
  readonly priorityUpdates: readonly H3PriorityUpdate[];
}

/**
 * Parses the start of a captured HTTP/3 control stream, decrypted and reassembled: the stream
 * type, a SETTINGS frame, then whole frames. This shows what a browser (or a client) sends there
 * without judging it, so unknown frames and repeated settings are kept. Values are QUIC
 * integers of up to 62 bits, hence `bigint`. Throws `TypeError` (`ERR_LK_INVALID_CONFIG`) for
 * bytes that are not such a stream or that end inside a frame.
 */
export function parseH3ControlStream(data: Uint8Array): H3ControlStream {
  return callNative(() => native.parseH3ControlStream(data));
}

/** What a client fingerprints as. */
export interface FingerprintInfo {
  /** Name of the TLS profile. */
  readonly tlsProfile: string;
  /** Number of HTTP/2 SETTINGS entries. */
  readonly h2SettingsCount: number;
  /** HTTP/2 connection WINDOW_UPDATE increment. */
  readonly h2WindowUpdate: number;
  /** The TCP fingerprint as JA4T, when the client has one. */
  readonly tcpJa4t?: string;
}

/** The outcome of `validateFingerprintConsistency()`. */
export interface FingerprintConsistency {
  /** Whether every given layer belongs to the same browser family. */
  readonly valid: boolean;
  /** One message per mismatch. */
  readonly warnings: readonly string[];
}

/**
 * Checks that TLS, HTTP/2 and TCP fingerprint names belong to one browser family (Chrome,
 * Firefox or Safari), since a mixed fingerprint is easy to spot. Names of other families are
 * not checked.
 */
export function validateFingerprintConsistency(layers: {
  readonly tlsProfile?: string;
  readonly h2Profile?: string;
  readonly tcpFingerprint?: string;
}): FingerprintConsistency {
  const tls = family(layers.tlsProfile);
  const warnings: string[] = [];
  for (const [label, name] of [
    ["H2 profile", layers.h2Profile],
    ["TCP fingerprint", layers.tcpFingerprint],
  ] as const) {
    const other = family(name);
    if (tls !== undefined && other !== undefined && tls !== other) {
      warnings.push(`TLS profile family '${tls}' does not match ${label} family '${other}'`);
    }
  }
  return { valid: warnings.length === 0, warnings };
}

/** The browser family a fingerprint name belongs to. */
function family(name: string | undefined): string | undefined {
  return ["chrome", "firefox", "safari"].find((browser) => name?.includes(browser));
}

/** A mutable copy of a list, as napi expects, or `undefined`. */
function list<T>(values: readonly T[] | undefined): T[] | undefined {
  return values === undefined ? undefined : [...values];
}

/** The native shape of a hand-built TLS profile. */
function toNativeTlsOptions(options: TlsProfileOptions): NativeTlsProfileOptions {
  return {
    name: options.name,
    cipherSuites: list(options.cipherSuites),
    extensions: options.extensions?.map((spec) => ({
      extensionType: spec.extensionType,
      source: spec.source,
      rawData: spec.rawData,
      trustAnchorIds: list(spec.trustAnchorIds),
      shuffle: spec.shuffle,
    })),
    supportedGroups: list(options.supportedGroups),
    signatureAlgorithms: list(options.signatureAlgorithms),
    keyShareCurves: list(options.keyShareCurves),
    alpnProtocols: list(options.alpnProtocols),
    tlsMinVersion: options.tlsMinVersion,
    tlsMaxVersion: options.tlsMaxVersion,
    ecPointFormats: list(options.ecPointFormats),
    compressionMethods: list(options.compressionMethods),
    grease: options.grease === undefined ? undefined : { ...options.grease },
    padding: options.padding === undefined ? undefined : { ...options.padding },
    alpsProtocols: list(options.alpsProtocols),
    compressCertAlgorithms: list(options.compressCertAlgorithms),
    recordSizeLimit: options.recordSizeLimit,
    delegatedCredentialsSigAlgs: list(options.delegatedCredentialsSigAlgs),
    sessionIdLength: options.sessionIdLength,
    shuffleExtensions: options.shuffleExtensions,
  };
}

/** The native shape of a hand-built TCP fingerprint; keep-alive becomes a switch plus timing. */
function toNativeTcpOptions(options: TcpFingerprintOptions): NativeTcpFingerprintOptions {
  const { tcpOptions, keepalive } = options;
  return {
    ...options,
    tcpOptions: tcpOptions === undefined ? undefined : [...tcpOptions],
    keepalive:
      keepalive === undefined
        ? undefined
        : typeof keepalive === "boolean"
          ? { enabled: keepalive }
          : { enabled: true, ...keepalive },
  };
}

/** The native shape of a hand-built HTTP/2 profile. */
function toNativeH2Options(options: H2ProfileOptions): NativeH2ProfileOptions {
  const { priorityConfig } = options;
  return {
    settings: options.settings.map(({ id, value }) =>
      typeof id === "number" ? { id, value } : { name: id, value },
    ),
    windowUpdate: options.windowUpdate,
    pseudoHeaderOrder: [...options.pseudoHeaderOrder],
    headersPriority:
      options.headersPriority === undefined ? undefined : { ...options.headersPriority },
    priorityFrames: options.priorityFrames?.map((frame) => ({ ...frame })),
    priorityConfig:
      priorityConfig === undefined || typeof priorityConfig === "string"
        ? priorityConfig === undefined
          ? undefined
          : { preset: priorityConfig }
        : { ...priorityConfig, urgencyWeights: list(priorityConfig.urgencyWeights) },
    initialStreamId: options.initialStreamId,
  };
}
