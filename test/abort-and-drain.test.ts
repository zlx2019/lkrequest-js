import { getEventListeners } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { AbortError, drainPending, pendingRequests, RequestError } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";

const session = testClient().session();

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

describe("AbortSignal", () => {
  it("rejects at once for an already-aborted signal", async () => {
    const reason = new Error("stop");
    const error = await session
      .get(serverUrl("/get"), { signal: AbortSignal.abort(reason) })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AbortError);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: reason });
    expect(pendingRequests()).toBe(0);
  });

  it("cancels a request in flight and releases it", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const request = session.get(serverUrl("/delay/5"), { signal: controller.signal });
    await waitFor(() => pendingRequests() === 1, 2_000);
    controller.abort();
    const error = await request.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AbortError);
    expect((error as AbortError).cause).toBeInstanceOf(DOMException);
    expect(performance.now() - started).toBeLessThan(2_000);
    // lkrequest-py's test_cancelling_a_request_releases_it: released well within 2 s.
    await waitFor(() => pendingRequests() === 0, 2_000);
  });

  it("reports AbortSignal.timeout() with its TimeoutError reason", async () => {
    const error = await session
      .get(serverUrl("/delay/5"), { signal: AbortSignal.timeout(100) })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AbortError);
    expect((error as AbortError).cause).toMatchObject({ name: "TimeoutError" });
  });

  it("removes its abort listener once the request settles", async () => {
    const controller = new AbortController();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        session.get(serverUrl("/get"), { signal: controller.signal }),
      ),
    );
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("stops reading a streamed body when the request is aborted", async () => {
    const controller = new AbortController();
    let closed = false;
    async function* endless(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          await sleep(10);
          yield new Uint8Array(1024);
        }
      } finally {
        closed = true;
      }
    }
    const request = session.post(serverUrl("/upload-echo"), {
      body: endless(),
      signal: controller.signal,
    });
    await sleep(100);
    controller.abort();
    await expect(request).rejects.toThrow(AbortError);
    await waitFor(() => closed, 2_000);
  });
});

describe("drainPending", () => {
  it("resolves true once every pending request has settled", async () => {
    const settled: boolean[] = [];
    const requests = Array.from({ length: 3 }, (_, i) =>
      session.get(serverUrl("/delay/1")).then(() => {
        settled[i] = true;
      }),
    );
    await waitFor(() => pendingRequests() === 3, 2_000);
    await expect(drainPending({ timeout: 10_000 })).resolves.toBe(true);
    // lkrequest-py's test_drain_true_implies_results_already_delivered.
    expect(settled).toEqual([true, true, true]);
    await Promise.all(requests);
  });

  it("resolves false when the timeout elapses first", async () => {
    const controller = new AbortController();
    const request = session
      .get(serverUrl("/delay/3"), { signal: controller.signal })
      .catch(() => {});
    await waitFor(() => pendingRequests() === 1, 2_000);
    await expect(drainPending({ timeout: 200 })).resolves.toBe(false);
    controller.abort();
    await request;
  });

  it("resolves true at once when nothing is pending", async () => {
    await expect(drainPending()).resolves.toBe(true);
  });
});
