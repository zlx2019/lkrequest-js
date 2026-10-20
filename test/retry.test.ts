import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client, ConnectionError, type RetryContext } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { closedPort, expectInvalidConfig } from "./support/helpers.js";

/** A `/flaky` URL that answers `status` to its first `fail` requests, then 200. */
function flaky(fail: number, status = 503): string {
  return serverUrl(`/flaky?key=${randomUUID()}&fail=${fail}&status=${status}`);
}

/** The attempt number `/flaky` reported. */
async function attemptOf(res: { json<T>(): Promise<T> }): Promise<number> {
  return (await res.json<{ attempt: number }>()).attempt;
}

describe("retry strategies", () => {
  it("retries a retryable status with the fixed strategy", async () => {
    const session = testClient().session({ retry: { strategy: "fixed", interval: 10 } });
    const res = await session.get(flaky(2));
    expect(res.status).toBe(200);
    await expect(attemptOf(res)).resolves.toBe(3);
  });

  it("gives up after maxRetries", async () => {
    const session = testClient().session({
      retry: { strategy: "exponential", maxRetries: 2, baseDelay: 5, maxDelay: 20 },
    });
    const res = await session.get(flaky(5, 429));
    expect(res.status).toBe(429);
    await expect(attemptOf(res)).resolves.toBe(3);
  });

  it("does not retry without a policy or for a status that is not retryable", async () => {
    const plain = await testClient().session().get(flaky(1));
    expect(plain.status).toBe(503);
    const session = testClient().session({ retry: { strategy: "fixed", interval: 10 } });
    const notRetryable = await session.get(flaky(1, 500));
    expect(notRetryable.status).toBe(500);
  });

  it("rejects an unknown strategy", () => {
    expectInvalidConfig(() =>
      testClient().session({ retry: { strategy: "linear" } as unknown as { strategy: "fixed" } }),
    );
    expectInvalidConfig(() => testClient().session({ retry: { strategy: "fixed", interval: -1 } }));
  });
});

describe("retry functions", () => {
  it("decides each retry and its delay", async () => {
    const calls: RetryContext[] = [];
    const session = testClient().session({
      retry: (context) => {
        calls.push(context);
        return context.attempt <= 2 ? 5 : null;
      },
    });
    const res = await session.get(flaky(10));
    expect(res.status).toBe(503);
    await expect(attemptOf(res)).resolves.toBe(3);
    expect(calls).toEqual([
      { attempt: 1, status: 503 },
      { attempt: 2, status: 503 },
      { attempt: 3, status: 503 },
    ]);
  });

  it("may be async", async () => {
    const session = testClient().session({
      retry: async ({ attempt }) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return attempt === 1 ? 1 : undefined;
      },
    });
    await expect(attemptOf(await session.get(flaky(1)))).resolves.toBe(2);
  });

  it("receives transport errors as RequestError subclasses", async () => {
    const errors: unknown[] = [];
    const session = testClient().session({
      retry: ({ attempt, error }) => {
        errors.push(error);
        return attempt < 2 ? 1 : null;
      },
    });
    const url = `https://127.0.0.1:${await closedPort()}/`;
    await expect(session.get(url)).rejects.toBeInstanceOf(ConnectionError);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(ConnectionError);
  });

  it("is asked about a POST, which is not replayed unless declared idempotent", async () => {
    let asked = 0;
    const session = testClient().session({
      retry: () => {
        asked += 1;
        return 1;
      },
    });
    const once = await session.post(flaky(1), { body: "x" });
    expect(once.status).toBe(503);
    expect(asked).toBe(1);
    const replayed = await session.post(flaky(1), { body: "x", idempotency: "idempotent" });
    await expect(attemptOf(replayed)).resolves.toBe(2);
  });

  it("stops retrying when the function throws or returns an invalid delay", async () => {
    const throwing = testClient().session({
      retry: () => {
        throw new Error("no");
      },
    });
    expect((await throwing.get(flaky(1))).status).toBe(503);
    const invalid = testClient().session({ retry: () => -5 });
    expect((await invalid.get(flaky(1))).status).toBe(503);
  });

  it("does not keep the process alive", () => {
    // The policy is a weak threadsafe function; creating it must not hold the event loop.
    expect(() => new Client().session({ retry: () => null })).not.toThrow();
  });
});
