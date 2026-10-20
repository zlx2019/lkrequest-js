/**
 * lkrequest: a Node.js HTTP client with byte-level TLS, HTTP/2 and HTTP/3 fingerprint
 * control, powered by Rust.
 *
 * @packageDocumentation
 */

export {
  type BrowserFamily,
  type Features,
  features,
  listPresets,
  type PresetInfo,
  version,
} from "./build-info.js";
export { Client } from "./client.js";
export { ClientPool, type ClientPoolOptions } from "./client-pool.js";
export { type Cookie, type CookieInit, CookieJar, type SameSite } from "./cookie-jar.js";
export type {
  RequestEndMessage,
  RequestErrorMessage,
  RequestStartMessage,
  TracedRequest,
  TracedResponse,
} from "./diagnostics.js";
export {
  AbortError,
  ConnectionError,
  type ErrorCode,
  HttpStatusError,
  JsonDecodeError,
  ProxyError,
  RequestError,
  type RequestErrorOptions,
  ResourceLimitError,
  TimeoutError,
  TlsError,
  TooManyRedirectsError,
} from "./errors.js";
export {
  type ExtensionSpec,
  ExtensionType,
  type FingerprintConsistency,
  type FingerprintInfo,
  type GreaseOptions,
  H2Profile,
  type H2ProfileOptions,
  type H2Setting,
  type H3ControlFrame,
  type H3ControlStream,
  type H3PriorityUpdate,
  type H3Setting,
  type HeadersPriority,
  type PaddingStrategy,
  type PriorityConfig,
  type PriorityFrame,
  type PseudoHeader,
  parseH3ControlStream,
  QuicProfile,
  TcpFingerprint,
  type TcpFingerprintOptions,
  type TcpKeepalive,
  TlsProfile,
  type TlsProfileOptions,
  type TlsVersion,
  validateFingerprintConsistency,
} from "./fingerprint.js";
export type { RequestEvent, RequestHook, ResponseEvent, ResponseHook } from "./hooks.js";
export { type CustomHsts, Hsts } from "./hsts.js";
export { type LogLevel, type LogListener, type LogRecord, onLog, setLogLevel } from "./logging.js";
export {
  enableMetrics,
  type HostMetrics,
  MetricsCollector,
  type MetricsSnapshot,
  metricsSnapshot,
  type TransportMetrics,
} from "./metrics.js";
export type { Middleware, MiddlewareRequest, MiddlewareResponse } from "./middleware.js";
export { drainPending, pendingRequests } from "./pending.js";
export {
  type AcquireOptions,
  type BadProxyOptions,
  type CustomProxyAuth,
  type HealthCheckOptions,
  ProxyConfig,
  type ProxyFactory,
  ProxyLease,
  ProxyPool,
  type ProxyPoolOptions,
  type ProxyProbeOptions,
  type ProxyRotation,
  type ProxySource,
} from "./proxy.js";
export { Response } from "./response.js";
export { type MethodOptions, Session } from "./session.js";
export {
  SessionLease,
  SessionPool,
  type SessionPoolOptions,
  type SessionPoolStats,
} from "./session-pool.js";
export { StreamingResponse } from "./streaming-response.js";
export type {
  AcquisitionPolicy,
  Auth,
  BodyInit,
  BrokenQuicOptions,
  BrokenQuicPolicy,
  BrokenQuicPreset,
  ClientOptions,
  ContentCoding,
  CustomDnsResolver,
  Diagnostics,
  DnsPreset,
  DnsResolver,
  DnsServer,
  FallbackPolicy,
  H2DataFramePolicy,
  H3RetryMode,
  HeadersInput,
  HttpIntent,
  HttpsRecord,
  HttpVersion,
  Idempotency,
  LimitOptions,
  MasqueOptions,
  NetworkPartitionContext,
  PairsInput,
  PoolStats,
  PreconnectResult,
  PreferredHttpVersion,
  PrefetchResult,
  ProtocolPolicy,
  ProtocolPolicyOptions,
  ProtocolPolicyPreset,
  RacePolicy,
  Randomize,
  RedirectMode,
  RedirectRecord,
  RequestOptions,
  RequestPriority,
  RetryContext,
  RetryFunction,
  RetryStrategy,
  SessionOptions,
  SessionResumption,
  TimeoutOptions,
  TlsOptions,
  TlsSessionCachePartitionPolicy,
  TlsSessionResumptionPolicy,
  UpgradePolicy,
} from "./types.js";
export {
  WebSocketConnection,
  type WebSocketMessage,
  type WebSocketOptions,
} from "./websocket.js";
