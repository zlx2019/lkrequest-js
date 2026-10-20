# Contributing to lkrequest-js

Thanks for your interest in contributing! lkrequest-js is the Node.js binding of the
[lkrequest](https://github.com/EZXLabs/lkrequest-rs) Rust HTTP client: a TypeScript facade
(`src/`) over a native addon built with [napi-rs](https://napi.rs) (`crates/lkrequest-napi/`),
which calls the Rust crates directly.

The bytes that go onto the network (TLS, HTTP/2 and HTTP/3 fingerprints) come from the Rust
library. A change that alters what is sent on the wire belongs in that repository; this one is
the binding layer: the API shape, the mapping of options and errors, the bridge between Rust and
JavaScript, and the packaging.

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE). Please also read the responsible-use expectations in
[SECURITY.md](SECURITY.md).

## Prerequisites

- Node.js 22.12 or later, and pnpm 10 through corepack (`corepack enable`; `package.json`
  pins the exact version).
- A recent stable Rust toolchain (edition 2024) with `rustfmt` and `clippy`.
- CMake and NASM, and a C toolchain for the TLS library: clang on Linux (on Debian or Ubuntu,
  `apt-get install clang cmake libclang-dev nasm perl pkg-config`), the Xcode command line tools
  on macOS, MSVC on Windows.
- [uv](https://docs.astral.sh/uv/): the tests start local HTTPS, HTTP/3 and MASQUE servers
  (`test/support/server.py`) whose Python dependencies are declared inline and fetched on first
  run. The tests never use the public network.

## Getting started

```bash
git clone https://github.com/EZXLabs/lkrequest-js
cd lkrequest-js
pnpm install
pnpm build:native:debug   # the first build compiles the whole Rust dependency tree
pnpm test
```

Cargo fetches the Rust library and its git submodules itself, so the first build needs network
access and takes several minutes.

| Command | What it does |
|---|---|
| `pnpm build:native:debug` | Builds the native addon, all features, debug profile. Run it after every change under `crates/`: the tests load the built addon |
| `pnpm test` | Runs the whole suite with vitest. One file: `pnpm exec vitest run test/cookies.test.ts` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | Biome, `cargo fmt --check` and `cargo clippy -D warnings` |
| `pnpm format` | Formats the TypeScript and the Rust code |
| `pnpm build` | Release build of the addon and `dist/` |

Both native build scripts enable every Cargo feature (`quic-h3`, `telemetry`, `synthetic-fp`,
`doh`, `masque`), and the tests assume them.

### Building against a local checkout of the Rust library

To try changes of the Rust library that are not merged yet, patch the git dependency in
`.cargo/config.toml` (git-ignored). The key is the URL used in
`crates/lkrequest-napi/Cargo.toml`, and every crate of that workspace the build needs must be
patched:

```toml
[patch."https://github.com/EZXLabs/lkrequest-rs"]
lkrequest = { path = "../lkrequest-rs/lkrequest" }
lkprofile = { path = "../lkrequest-rs/lkprofile" }
# also lktls, lkh2, lkh3, lkquic, lktls-quic and lkmasque
```

## Project layout

| Path | Contents |
|---|---|
| `src/` | TypeScript source of the public API; `src/internal/` is not exported |
| `crates/lkrequest-napi/` | The Rust native addon (a private implementation detail) |
| `native/` | Generated native loader and type declarations; never edit by hand |
| `test/` | Vitest tests; `test/support/` holds the test servers and helpers |
| `examples/` | Runnable TypeScript examples, simplest first; see `examples/README.md` for how to run them |
| `scripts/` | Build and release helper scripts |
| `.github/workflows/` | CI and npm publishing |

## Code style

**TypeScript**

- ESM only. Relative imports end in `.js`; type imports use `import type`; exports are named,
  never default.
- `tsconfig.json` is strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly`, `isolatedDeclarations`): no `enum`, `namespace` or parameter properties,
  and exports need explicit types.
- File names are kebab-case, types PascalCase, functions and properties camelCase. A string
  value that names an upstream identifier stays snake_case (`"chrome_154"`).
- Durations are milliseconds. Failures use the classes in `src/errors.ts`, which carry a
  `code` (`ERR_LK_*`).
- Biome sets the format: two-space indent, 100 columns, double quotes. `pnpm format` applies it.

**Rust**

- `rustfmt` and `clippy -D warnings` must pass. Non-test code does not use `unwrap()` or
  `expect()`.
- Every `#[napi]` export has a `///` doc comment; these end up in the generated declarations.

**Both**: comments are in English, and every exported symbol and function has a doc comment.

### Things that bite in the native layer

- `native/index.cjs` and `native/index.d.cts` are generated. After you change Rust exports,
  rebuild and commit the regenerated `native/index.d.cts`.
- A panic in a native function aborts the Node.js process, so return errors instead.
- Rust calls JavaScript functions only through `crates/lkrequest-napi/src/bridge/callback.rs`.
  `call` awaits the returned promise with a timeout; `call_blocking` serves the few synchronous
  upstream traits and works only inside a Tokio task; notification callbacks (the TLS key log,
  log events) never wait. Notification callbacks that throw would terminate the process, so the
  TypeScript side wraps them in `try/catch` (`src/internal/log.ts`).
- Some synchronous upstream methods spawn Tokio tasks. Enter the runtime
  (`crates/lkrequest-napi/src/runtime.rs`) before calling them from the JavaScript thread.
- A failed request does not reject at the native boundary: the native `request` resolves
  `{ response }` or `{ error }`, and `src/internal/native-error.ts` turns the error into the
  matching class. Entry points that count as requests register with the in-flight tracker before
  they return their future, so `drainPending()` sees them.
- Bytes handed to JavaScript go through `bridge::buffer::ExternalBytes`: V8 does not allow two
  external buffers over the same memory, and the helper copies when the memory is shared.

## Tests

- Tests live in `test/**/*.test.ts`, and a change in behavior comes with a test.
- Test files run in parallel, one process each; the tests inside a file run in order. Put
  assertions that depend on process-wide state (the in-flight count, log output) in one file.
- Use the helpers in `test/support/clients.ts` (`testClient()`, `serverUrl()`, `h3Url()`); the
  forward proxies and the UDP DNS server are in `test/support/proxies.ts` and
  `test/support/dns-server.ts`. Do not depend on the public network.

## Before you open a pull request

CI runs the whole suite on Linux, macOS and Windows, on Node.js 22, 24 and 26. Before you push:

1. `pnpm lint` and `pnpm typecheck` pass.
2. `pnpm test` passes. After a Rust change, run `pnpm build:native:debug` first.
3. You added or updated tests, and committed the regenerated `native/index.d.cts` if the Rust
   exports changed.
4. User-visible changes have an entry under "Unreleased" in `CHANGELOG.md`, and the README
   mentions new public API where it helps.
5. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

Keep a pull request to one concern, and describe what changed and why.

## Reporting bugs and security issues

- For bugs and feature requests, open a GitHub issue with the lkrequest version, your Node.js
  version and platform, and a minimal reproduction. `setLogLevel("lkrequest=debug")` together
  with `onLog()` shows what the Rust library did. Remove credentials, cookies and TLS key logs
  first.
- For security vulnerabilities, do not open a public issue. Follow [SECURITY.md](SECURITY.md).
