import { once } from "node:events";
import { availableParallelism } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { pendingRequests } from "../src/index.js";
import { native } from "../src/internal/native.js";
import { server } from "./support/clients.js";

const { testing } = native;

// Upstream's synchronous traits reach JavaScript through `block_in_place` plus a threadsafe
// function. These tests pin down the bridge's safety rules through the `native.testing`
// hooks, since no public API may reach the JavaScript-thread guard.

/** Polls `condition` until it holds, failing after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await sleep(20);
  }
}

/** Starts a worker from `test/fixtures` and waits for its first message. */
async function startWorker(fixture: string): Promise<Worker> {
  const worker = new Worker(new URL(`./fixtures/${fixture}`, import.meta.url), {
    workerData: server,
  });
  await once(worker, "message");
  return worker;
}

describe("sync callback bridge", () => {
  it("resolves with the callback's result", async () => {
    await expect(testing.syncCall(async (value) => value * 2, 21, 1_000)).resolves.toBe(42);
  });

  it("waits for a callback that settles later", async () => {
    const callback = async (value: number): Promise<number> => {
      await sleep(50);
      return value + 1;
    };
    await expect(testing.syncCall(callback, 1, 1_000)).resolves.toBe(2);
  });

  it("reports a rejected Promise as an error", async () => {
    const callback = async (): Promise<number> => {
      throw new Error("async boom");
    };
    await expect(testing.syncCall(callback, 1, 1_000)).rejects.toThrow(/async boom/);
  });

  it("reports a synchronous throw as an error instead of crashing", async () => {
    const callback = (): Promise<number> => {
      throw new Error("sync boom");
    };
    await expect(testing.syncCall(callback, 1, 1_000)).rejects.toThrow(/sync boom/);
  });

  it("gives up after the timeout", async () => {
    const started = performance.now();
    const never = (): Promise<number> => new Promise(() => {});
    await expect(testing.syncCall(never, 1, 200)).rejects.toThrow(/within 200 ms/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("refuses to block the JavaScript thread", () => {
    const started = performance.now();
    expect(() => testing.syncCallOnJsThread(async (value) => value, 1)).toThrow(
      /outside the Tokio runtime/,
    );
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("keeps the runtime responsive while callbacks block its workers", async () => {
    // Twice as many blocked calls as there are workers: without `block_in_place` handing the
    // workers' tasks to replacement threads, the timer below could not fire until they return.
    const blocked = availableParallelism() * 2;
    const slow = async (value: number): Promise<number> => {
      await sleep(300);
      return value;
    };
    const calls = Array.from({ length: blocked }, (_, i) => testing.syncCall(slow, i, 5_000));
    await waitFor(() => testing.blockedCalls() === blocked, 1_000);

    const started = performance.now();
    await testing.sleep(10);
    const latency = performance.now() - started;

    await expect(Promise.all(calls)).resolves.toEqual(Array.from({ length: blocked }, (_, i) => i));
    expect(latency).toBeLessThan(150);
  });
});

describe("worker teardown", () => {
  it("releases a blocked call when its worker is terminated", async () => {
    const worker = await startWorker("blocked-call-worker.mjs");
    expect(testing.blockedCalls()).toBe(1);
    await worker.terminate();
    // The fixture's timeout is 1.5 s, which bounds the wait even if the environment never
    // answers the pending call.
    await waitFor(() => testing.blockedCalls() === 0, 3_000);
  });

  it("drops results that arrive after the worker is gone", async () => {
    const worker = await startWorker("late-result-worker.mjs");
    await worker.terminate();
    // The worker's request and native work complete into a destroyed environment meanwhile;
    // reaching the next lines at all proves the process survived it.
    await sleep(1_500);
    await expect(testing.sleep(1)).resolves.toBeUndefined();
    // An undeliverable result releases its in-flight slot too.
    expect(pendingRequests()).toBe(0);
  });
});
