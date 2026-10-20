// HSTS and HTTPS only
//
// HTTP Strict Transport Security tells a browser to use https:// for a host from now on. A
// session can do the same: with a list of hosts, with what servers announce, or with a function
// of your own. `httpsOnly` goes further and refuses http:// altogether.
//
// Run: node examples/hsts.ts (see examples/README.md)

import { Client, Hsts, RequestError } from "lkrequest";

const client = new Client();
const url = "http://httpbin.org/get";

// Without a policy, an http:// URL is sent as it is.
console.log("none   ", (await client.session().get(url)).url);

// A static policy names hosts, and their subdomains, that are always upgraded to https://.
const pinned = client.session({ hsts: Hsts.static(["httpbin.org"]) });
console.log("static ", (await pinned.get(url)).url);

// A dynamic policy starts from a list and learns from `Strict-Transport-Security` headers.
// Sessions given the same policy share what it learned, like the sessions of one browser.
const dynamic = Hsts.dynamic(["httpbin.org"]);
console.log("dynamic", (await client.session({ hsts: dynamic }).get(url)).url);

// Or decide yourself. The function must answer at once, with a boolean.
const custom = Hsts.custom({ shouldUpgrade: (host) => host.endsWith("httpbin.org") });
console.log("custom ", (await client.session({ hsts: custom }).get(url)).url);

// `httpsOnly` refuses an http:// URL that no policy upgraded.
try {
  await client.session({ httpsOnly: true }).get(url);
} catch (error) {
  if (error instanceof RequestError) {
    console.log("https only:", error.message);
  }
}
