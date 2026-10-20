// Checks that every place carrying the package version agrees, before a release is built.
//
// The version lives in package.json, in the Cargo workspace (it becomes the addon's own
// `version`), and in the generated loader `native/index.cjs`, which checks installed binding
// packages against it. A release tag (`v0.1.0` or `public-v0.1.0`) must name the same version.
//
// Usage: node scripts/check-version.mjs [tag]

import { readFileSync } from "node:fs";

/** Reads a file of this repository as text. */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The version in the `[workspace.package]` table of the root Cargo.toml. */
function cargoVersion() {
  const table = read("Cargo.toml").split("[workspace.package]")[1] ?? "";
  return /^version\s*=\s*"([^"]+)"/m.exec(table)?.[1];
}

/** The versions the generated loader expects of the binding packages. */
function loaderVersions() {
  const matches = read("native/index.cjs").matchAll(/expected ([^ ]+) but got/g);
  return new Set(Array.from(matches, (match) => match[1]));
}

const expected = JSON.parse(read("package.json")).version;
const problems = [];

const cargo = cargoVersion();
if (cargo !== expected) {
  problems.push(`Cargo.toml [workspace.package] has ${cargo}`);
}
const loader = loaderVersions();
if (loader.size !== 1 || !loader.has(expected)) {
  problems.push(
    `native/index.cjs expects ${[...loader].join(", ") || "nothing"} (rebuild the addon)`,
  );
}
const tag = process.argv[2];
if (tag !== undefined && tag.replace(/^(public-)?v/, "") !== expected) {
  problems.push(`tag ${tag} names another version`);
}

if (problems.length > 0) {
  console.error(`check-version: package.json has ${expected}, but:`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}
console.log(`check-version: ok (${expected}${tag === undefined ? "" : `, tag ${tag}`})`);
