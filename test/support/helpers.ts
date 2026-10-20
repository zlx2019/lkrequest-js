import { createServer } from "node:net";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect } from "vitest";

/** Expects `build` to throw the facade's invalid-option error. */
export function expectInvalidConfig(build: () => unknown): void {
  expect(build).toThrow(TypeError);
  try {
    build();
  } catch (error) {
    expect(error).toMatchObject({ code: "ERR_LK_INVALID_CONFIG" });
  }
}

/** A loopback port that nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Polls `condition` every 10 ms until it holds, failing after `timeout` milliseconds. */
export async function waitFor(condition: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeout} ms`);
    }
    await sleep(10);
  }
}

/** Returns V8's `gc()` without needing `--expose-gc` on the test runner's command line. */
function exposeGc(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

const gc = exposeGc();

/** Runs full collections and gives the deferred Node-API finalizers a chance to run. */
export async function collectGarbage(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    gc();
    await nextTurn();
  }
}
