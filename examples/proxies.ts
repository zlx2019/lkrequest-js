// Proxies
//
// Send requests through an HTTP, SOCKS5 or chained proxy.
//
// This example needs a proxy of your own. It uses the URL in PROXY_URL, or
// http://127.0.0.1:8080 when that is not set.
//
// Run: PROXY_URL=socks5h://127.0.0.1:1080 node examples/proxies.ts (see examples/README.md)

import { Client, ProxyConfig } from "lkrequest";

const client = new Client();

// A proxy is a URL. `http://` opens a tunnel with CONNECT; `socks5://` resolves the target's
// name on this side, `socks5h://` leaves that to the proxy.
const url = process.env.PROXY_URL ?? "http://127.0.0.1:8080";
const proxy = ProxyConfig.parse(url);
console.log(proxy.host, proxy.port);

// Every request of a session goes through its proxy.
const session = client.session({ proxy });
const res = await session.get("https://httpbin.org/ip");
console.log(await res.json()); // the proxy's address, not yours

// A single request can name its own proxy.
console.log((await client.get("https://httpbin.org/ip", { proxy: url })).status);

// Find out whether a proxy works: it opens a tunnel to the target and reports how long it took.
const milliseconds = await proxy.healthCheck({ host: "example.com", port: 443 });
console.log(`tunnel opened in ${milliseconds} ms`);

// Credentials can be part of the URL (http://user:pw@host:port) or added afterwards.
const withCredentials = proxy.withUserPass("user", "pass");

// A chain connects to the first proxy, which connects to the next, and so on.
const chain = ProxyConfig.chain([url, "socks5://127.0.0.1:1081"]);

// The identity of a proxy has its user name, never the password.
console.log(withCredentials.identity, chain.hopCount);
