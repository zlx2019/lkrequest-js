import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LogRecord, onLog, setLogLevel } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";

// Logging is process-wide; vitest runs each test file in its own process.
const session = testClient().session();
const unsubscribers: Array<() => void> = [];

afterEach(() => {
  setLogLevel("off");
  for (const unsubscribe of unsubscribers.splice(0)) {
    unsubscribe();
  }
  vi.restoreAllMocks();
});

/** Registers a listener that appends every record to the returned list. */
function collect(): LogRecord[] {
  const records: LogRecord[] = [];
  unsubscribers.push(onLog((record) => records.push(record)));
  return records;
}

/** Waits until a record with `message` arrives (records are delivered asynchronously). */
async function waitForMessage(records: LogRecord[], message: string): Promise<LogRecord> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = records.find((record) => record.message === message);
    if (found) {
      return found;
    }
    await sleep(10);
  }
  throw new Error(`no "${message}" record arrived`);
}

describe("logging", () => {
  it("delivers request events to listeners", async () => {
    const records = collect();
    setLogLevel("lkrequest_napi=debug");
    await session.get(serverUrl("/get"));
    const received = await waitForMessage(records, "response received");
    expect(received).toMatchObject({
      level: "debug",
      target: "lkrequest_napi::request",
      fields: { method: "GET", status: "200" },
    });
    expect(received.timestamp).toBeGreaterThan(Date.now() - 60_000);
    await waitForMessage(records, "sending request");
  });

  it("filters by directive", async () => {
    const records = collect();
    setLogLevel("lkrequest_napi=error");
    await session.get(serverUrl("/get"));
    await session.get("https://127.0.0.1:1/").catch(() => {});
    const failed = await waitForMessage(records, "request failed");
    expect(failed.level).toBe("error");
    expect(records.some((record) => record.level === "debug")).toBe(false);
  });

  it("stops delivering after unsubscribing and when turned off", async () => {
    const records: LogRecord[] = [];
    const unsubscribe = onLog((record) => records.push(record));
    setLogLevel("lkrequest_napi=debug");
    await session.get(serverUrl("/get"));
    await waitForMessage(records, "response received");
    unsubscribe();
    const after = collect();
    setLogLevel("off");
    const count = records.length;
    await session.get(serverUrl("/get"));
    await sleep(100);
    expect(records).toHaveLength(count);
    expect(after).toHaveLength(0);
  });

  it("writes to stderr while no listener is registered", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLogLevel("lkrequest_napi=debug");
    await session.get(serverUrl("/get"));
    for (let attempt = 0; attempt < 100 && write.mock.calls.length === 0; attempt++) {
      await sleep(10);
    }
    const lines = write.mock.calls.map(([chunk]) => String(chunk));
    expect(lines.some((line) => /DEBUG lkrequest_napi::request: sending request/.test(line))).toBe(
      true,
    );
  });

  it("rejects an invalid directive", () => {
    expect(() => setLogLevel("lkrequest=loud")).toThrow(
      expect.objectContaining({ name: "TypeError", code: "ERR_LK_INVALID_CONFIG" }),
    );
  });
});
