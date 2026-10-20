// Offline smoke test of a release build, for CI targets that do not run the full suite.
//
// Loads the built package from `dist/` with the native addon in `native/`, and checks what a
// broken artifact would get wrong: the addon loads on this platform, its version matches the
// package, every optional capability is compiled in, and a client can be created. It never
// touches the network.
//
// Usage: node scripts/smoke.mjs. CI also runs it, best effort, under Bun (`bun scripts/smoke.mjs`)
// and Deno (`deno run -A scripts/smoke.mjs`).

import { readFileSync } from "node:fs";
import { Client, features, listPresets, version } from "../dist/index.js";

/** Fails the run with a message. */
function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (version !== pkg.version) {
  fail(`native addon reports version ${version}, package.json has ${pkg.version}`);
}

const missing = Object.entries(features())
  .filter(([, enabled]) => !enabled)
  .map(([name]) => name);
if (missing.length > 0) {
  fail(`release builds must enable every feature, missing: ${missing.join(", ")}`);
}

const presets = listPresets();
if (presets.length === 0) {
  fail("the build lists no browser presets");
}

const client = new Client({ preset: presets[0].name });
client.session().close();

// Bun and Deno report a Node.js version of their own as well, so name the runtime that ran.
const { bun, deno, node } = process.versions;
const runtime = bun ? `bun ${bun}` : deno ? `deno ${deno}` : `node ${node}`;
console.log(
  `smoke: ok (lkrequest ${version}, ${process.platform}-${process.arch}, ${runtime}, ` +
    `${presets.length} presets)`,
);
