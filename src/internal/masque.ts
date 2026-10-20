import type { NativeMasqueOptions } from "../../native/index.cjs";
import type { MasqueOptions } from "../types.js";

const encoder = new TextEncoder();

/** The native shape of the MASQUE outer-hop options; `null` keeps idle tunnels. */
export function toNativeMasqueOptions(options: MasqueOptions): NativeMasqueOptions {
  const { ca, tunnelIdleTimeout } = options;
  const certificates = ca === undefined ? undefined : Array.isArray(ca) ? ca : [ca];
  return {
    serverName: options.serverName,
    caPem: certificates?.map((pem: string | Uint8Array) =>
      typeof pem === "string" ? encoder.encode(pem) : pem,
    ),
    useNativeCerts: options.useNativeCerts,
    rejectUnauthorized: options.rejectUnauthorized,
    tunnelIdleTimeout: tunnelIdleTimeout === null ? Number.POSITIVE_INFINITY : tunnelIdleTimeout,
    maxIdleTunnels: options.maxIdleTunnels,
  };
}
