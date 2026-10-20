// Blocks a runtime worker on a callback that never settles, then waits to be terminated.
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";

const native = createRequire(import.meta.url)("../../native/index.cjs");

native.testing
  .syncCall(
    () => {
      parentPort.postMessage("called");
      return new Promise(() => {});
    },
    1,
    1_500,
  )
  .catch(() => {});
