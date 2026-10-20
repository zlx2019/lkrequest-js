import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ConnectionError, RequestError } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { closedPort, waitFor } from "./support/helpers.js";

describe("poolStats and clearPool", () => {
  it("starts empty and counts the connection a request leaves behind", async () => {
    const session = testClient().session();
    expect(session.poolStats()).toMatchObject({
      total: 0,
      h1Connections: 0,
      h2Connections: 0,
      h3Connections: 0,
      maxTotal: Number.POSITIVE_INFINITY,
      atCapacity: false,
    });
    await session.get(serverUrl("/get"));
    expect(session.poolStats()).toMatchObject({ total: 1, h2Connections: 1 });
    session.clearPool();
    expect(session.poolStats().h2Connections).toBe(0);
    // A cleared connection frees its slot once it has shut down.
    await waitFor(() => session.poolStats().total === 0);
  });

  it("counts a connection that is serving a request against the limit", async () => {
    // The limit is on physical connections, so a checked-out HTTP/1.1 connection occupies its
    // slot without sitting idle in the pool, and a concurrent request must be refused rather
    // than dial past the limit.
    const session = testClient().session({ preferredHttpVersion: "http1_only", maxConnections: 1 });
    const first = session.get(serverUrl("/delay/2"));
    await waitFor(() => session.poolStats().total === 1);
    expect(session.poolStats()).toMatchObject({
      total: 1,
      maxTotal: 1,
      h1Connections: 0,
      atCapacity: true,
    });
    await expect(session.get(serverUrl("/get"))).rejects.toThrow(/connection limit reached/);
    expect((await first).status).toBe(200);
  });
});

describe("preconnect", () => {
  it("opens the connection the next request reuses", async () => {
    const session = testClient().session();
    await session.preconnect(serverUrl("/"));
    expect(session.poolStats().total).toBe(1);
    const res = await session.get(serverUrl("/get"));
    expect(res.diagnostics.tcpMs).toBeUndefined();
    expect(session.poolStats().total).toBe(1);
  });

  it("rejects with the connection error", async () => {
    const url = `https://127.0.0.1:${await closedPort()}/`;
    await expect(testClient().session().preconnect(url)).rejects.toBeInstanceOf(ConnectionError);
  });

  it("reports each URL of preconnectMany without rejecting", async () => {
    const refused = `https://127.0.0.1:${await closedPort()}/`;
    const results = await testClient()
      .session()
      .preconnectMany([serverUrl("/"), refused]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ url: serverUrl("/"), ok: true });
    expect(results[1]).toMatchObject({ url: refused, ok: false });
    expect(results[1]?.error).toBeInstanceOf(ConnectionError);
  });

  it("prefetches with HEAD requests and reports the time spent", async () => {
    const refused = `https://127.0.0.1:${await closedPort()}/`;
    const session = testClient().session();
    const results = await session.prefetch([serverUrl("/get"), refused]);
    expect(results[0]).toMatchObject({ url: serverUrl("/get"), ok: true });
    expect(results[0]?.duration).toBeGreaterThan(0);
    expect(results[1]).toMatchObject({ url: refused, ok: false });
    expect(results[1]?.error).toBeInstanceOf(RequestError);
    expect(session.poolStats().total).toBe(1);
  });
});

describe("close", () => {
  it("clears the pool and refuses further requests", async () => {
    const session = testClient().session();
    await session.get(serverUrl("/get"));
    expect(session.closed).toBe(false);
    session.close();
    expect(session.closed).toBe(true);
    await waitFor(() => session.poolStats().total === 0);
    await expect(session.get(serverUrl("/get"))).rejects.toMatchObject({
      name: "RequestError",
      code: "ERR_LK_SESSION_CLOSED",
      url: serverUrl("/get"),
    });
    await expect(session.preconnect(serverUrl("/"))).rejects.toMatchObject({
      code: "ERR_LK_SESSION_CLOSED",
    });
  });

  it("lets a request already in flight finish", async () => {
    const session = testClient().session();
    const pending = session.get(serverUrl("/delay/1"));
    await sleep(200);
    session.close();
    expect((await pending).status).toBe(200);
  });

  it("closes on Symbol.dispose", () => {
    const session = testClient().session();
    session[Symbol.dispose]();
    expect(session.closed).toBe(true);
  });
});
