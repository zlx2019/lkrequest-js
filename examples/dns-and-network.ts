// DNS and network
//
// How the client finds a server's address: the system resolver, a public one, a DNS server of
// your choice, DNS over HTTPS, or a function of your own. `family` limits the address family,
// and `connectTo` skips the lookup for the hosts you name.
//
// Run: node examples/dns-and-network.ts (see examples/README.md)

import { resolve4 } from "node:dns/promises";
import { Client, type ClientOptions } from "lkrequest";

const [address] = await resolve4("httpbin.org");

const variants: Record<string, ClientOptions> = {
  system: {}, // the operating system's resolver, the default
  cached: { dnsCache: { ttl: 60_000 } }, // the system resolver, with its answers kept a minute
  cloudflare: { dns: "cloudflare" }, // a built-in preset: system, google, cloudflare, quad9
  server: { dns: { server: "8.8.8.8" } }, // any DNS server, as an IP with an optional port
  doh: { dns: "google_https" }, // DNS over HTTPS
  ipv4: { family: 4 }, // connect over IPv4 only; 6 is IPv6 only, 0 is either
  // Dial this address for that host. The URL, the TLS server name and the Host header stay.
  pinned: { connectTo: { "httpbin.org:443": `${address}:443` } },
  yours: {
    dns: {
      // Return the addresses to try, in order. It may be async.
      resolve: async (host) => {
        console.log("  resolving", host);
        return resolve4(host);
      },
    },
  },
};

for (const [name, options] of Object.entries(variants)) {
  try {
    const res = await new Client(options).get("https://httpbin.org/get");
    console.log(name, res.status, res.diagnostics.remoteAddr);
  } catch (error) {
    console.log(name, "failed:", error instanceof Error ? error.message : error);
  }
}
