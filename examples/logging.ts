// Logging
//
// The log events of the Rust library underneath: off until you pick a level, then printed to
// stderr or handed to a listener of your own.
//
// Run: node examples/logging.ts (see examples/README.md)

import { Client, onLog, setLogLevel } from "lkrequest";

const client = new Client();
const url = "https://httpbin.org/get";

// 1. Pick what to log with the syntax of Rust's `tracing` filters: a level, a level per
// target, or "off". With no listener, the events go to stderr.
setLogLevel("lkrequest=info");
await client.session().get(url);

// 2. A listener takes the place of stderr, for as long as it is registered. Forward the
// records to pino, or any other logger. `debug` says much more than `info`.
const stopLogging = onLog((record) => {
  console.log(
    `[${record.level}] ${record.target}: ${record.message}`,
    JSON.stringify(record.fields),
  );
});
setLogLevel("lkrequest=debug");
await client.session().get(url);
stopLogging();

// 3. Targets can have levels of their own: warnings and errors from everywhere, and the DNS
// lookups in full. A new session opens a new connection, which looks the name up again.
setLogLevel("lkrequest=warn,lkrequest::dns=debug");
await client.session().get(url);

setLogLevel("off");
