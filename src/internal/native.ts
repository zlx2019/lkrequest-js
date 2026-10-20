import { createRequire } from "node:module";

/** Shape of the private native binding, as declared by the napi-rs generated types. */
export type NativeBinding = typeof import("../../native/index.cjs");

const require = createRequire(import.meta.url);

/**
 * The private native binding, loaded once per process.
 *
 * The napi-rs generated loader picks the `.node` file for the current platform: a local
 * build in `native/` first, then the matching `@lkrequest/binding-*` package. Nothing outside
 * this package should import it; the public API lives in the modules that wrap it.
 */
export const native: NativeBinding = require("../../native/index.cjs") as NativeBinding;
