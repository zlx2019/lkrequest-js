// TLS options
//
// The client checks the server's certificate. This shows what a failed check looks like, how to
// switch it off, and how to write out the TLS secrets so that Wireshark can decrypt a capture.
//
// Run: node examples/tls-options.ts (see examples/README.md)

import { resolve4 } from "node:dns/promises";
import { Client, TlsError } from "lkrequest";

// httpbin's certificate is issued for the name httpbin.org, not for its IP address. Asking for
// the address makes the certificate and the name disagree.
const [address] = await resolve4("httpbin.org");
const url = `https://${address}/get`;

// A certificate that does not match is an error. The message says why.
try {
  await new Client().get(url);
} catch (error) {
  if (error instanceof TlsError) {
    console.log(error.code, error.phase);
  }
}

// `rejectUnauthorized: false` skips the check. Use it for testing, never in production.
const lax = new Client({ tls: { rejectUnauthorized: false } });
console.log((await lax.get(url)).status);

// To trust a private certificate authority instead, pass its PEM as `tls: { ca }`.
// `useNativeCerts: true` trusts the operating system's certificate store as well.

// A key log function gets the TLS secrets in the NSS key log format, one line at a time. Give
// `keylog` a file path instead, and the lines are appended there.
const lines: string[] = [];
const logging = new Client({ tls: { keylog: (line) => lines.push(line) } });
await logging.get("https://httpbin.org/get");
console.log("key log lines:", lines.length, lines[0]?.split(" ")[0]); // e.g. CLIENT_RANDOM
