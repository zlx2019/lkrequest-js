import { inject } from "vitest";
import { Client, type ClientOptions } from "../../src/index.js";

/** The local test servers started by the global setup (see `global-setup.ts`). */
export const server: {
  readonly url: string;
  readonly ca: string;
  readonly key: string;
  readonly h3Url: string;
  readonly h3UrlIpv6: string | null;
  readonly masqueUrl: string;
  readonly h3ClosingUrl: string;
} = inject("server");

/** A client that trusts the test server's self-signed certificate. */
export function testClient(options: ClientOptions = {}): Client {
  return new Client({ ...options, tls: { ca: server.ca, ...options.tls } });
}

/** A URL on the test server. */
export function serverUrl(path: string): string {
  return new URL(path, server.url).href;
}

/** A URL on the HTTP/3 test server. */
export function h3Url(path: string): string {
  return new URL(path, server.h3Url).href;
}
