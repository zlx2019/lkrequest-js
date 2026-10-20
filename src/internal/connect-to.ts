import type { NativeDialOverride } from "../../native/index.cjs";
import type { PairsInput } from "../types.js";
import { invalidConfig } from "./native-error.js";
import { flattenPairs, unflatten } from "./pairs.js";

/**
 * Splits the `connectTo` entries into origins and addresses. Hosts are normalized the way
 * `URL` normalizes them (lower case, punycode, IPv6 in brackets), which is also how upstream
 * keys its table; the native layer validates the addresses and the family.
 */
export function toDialOverrides(entries: PairsInput): NativeDialOverride[] {
  return unflatten(flattenPairs(entries)).map(([origin, address]) => ({
    ...parseOrigin(origin),
    address,
  }));
}

/** Splits a `"host:port"` key into a normalized host and a port. */
function parseOrigin(origin: string): { host: string; port: number } {
  const invalid = (why: string): TypeError =>
    invalidConfig(
      `connectTo key ${JSON.stringify(origin)} ${why}; expected "host:port" (an IPv6 host in brackets, e.g. "[::1]:443")`,
    );
  let host: string;
  let port: string;
  if (origin.startsWith("[")) {
    const end = origin.indexOf("]:");
    if (end < 0) throw invalid("has no port");
    host = origin.slice(0, end + 1);
    port = origin.slice(end + 2);
  } else {
    const colon = origin.lastIndexOf(":");
    if (colon < 0) throw invalid("has no port");
    host = origin.slice(0, colon);
    port = origin.slice(colon + 1);
    if (host.includes(":")) throw invalid("has an unbracketed IPv6 host");
  }
  const number = /^\d{1,5}$/.test(port) ? Number(port) : 0;
  if (number < 1 || number > 65_535) throw invalid("has an invalid port");
  return { host: normalizeHost(host, invalid), port: number };
}

/** The host as `URL` spells it, rejecting anything that is not a bare host. */
function normalizeHost(host: string, invalid: (why: string) => TypeError): string {
  if (host === "" || /[/?#@\\\s]/.test(host)) throw invalid("has an invalid host");
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    throw invalid("has an invalid host");
  }
}
