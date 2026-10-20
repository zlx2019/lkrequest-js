import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AbortError,
  type Middleware,
  ProxyConfig,
  Session,
  SessionLease,
  SessionPool,
} from "../src/index.js";
import { server, serverUrl, testClient } from "./support/clients.js";
import { collectGarbage, expectInvalidConfig, waitFor } from "./support/helpers.js";
import { startConnectProxy, type TestProxy } from "./support/proxies.js";

/** Polls the pool until `expected` sessions are idle, returning the last count seen. */
async function idleSoon(pool: SessionPool, expected: number): Promise<number> {
  let idle = 0;
  for (let i = 0; i < 100; i++) {
    idle = (await pool.stats()).idleSessions;
    if (idle >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return idle;
}

describe("SessionPool", () => {
  let proxy: TestProxy;

  beforeAll(async () => {
    proxy = await startConnectProxy();
  });

  afterAll(async () => {
    await proxy.close();
  });

  it("leases sessions bound to the pool's proxies", async () => {
    const pool = new SessionPool(testClient(), { proxies: [proxy.url], maxSessions: 2 });
    using lease = await pool.acquire();
    expect(lease).toBeInstanceOf(SessionLease);
    expect(lease.session).toBeInstanceOf(Session);
    const before = proxy.targets.length;
    expect((await lease.session.get(serverUrl("/get"))).status).toBe(200);
    expect(proxy.targets.length).toBe(before + 1);
    await expect(pool.stats()).resolves.toEqual({ idleSessions: 0, maxSessions: 2 });
  });

  it("returns a released session to the pool, keeping its cookies", async () => {
    // Released on the JavaScript thread, outside the Tokio runtime.
    const pool = new SessionPool(testClient(), { proxies: [proxy.url], maxSessions: 1 });
    const first = await pool.acquire();
    await first.session.get(serverUrl("/cookies/set?kept=1"));
    first.release();
    await expect(idleSoon(pool, 1)).resolves.toBe(1);
    using second = await pool.acquire();
    expect(second.session.cookies.getValues(serverUrl("/"), "kept")).toEqual(["1"]);
  });

  it("returns the session on Symbol.dispose and when the lease is garbage collected", async () => {
    const pool = new SessionPool(testClient(), { proxies: [proxy.url], maxSessions: 2 });
    {
      using _lease = await pool.acquire();
    }
    await expect(idleSoon(pool, 1)).resolves.toBe(1);
    // Leased and dropped unreleased: the finalizer returns them.
    await (async () => {
      await pool.acquire();
      await pool.acquire();
    })();
    await collectGarbage();
    await expect(idleSoon(pool, 2)).resolves.toBe(2);
  });

  it("discards a session marked bad instead of returning it", async () => {
    const pool = new SessionPool(testClient(), { proxies: [proxy.url], maxSessions: 1 });
    const lease = await pool.acquire();
    lease.markBad();
    lease.release();
    // The slot is free again, but nothing went back to the idle list.
    using next = await pool.acquire();
    expect(next.session).toBeInstanceOf(Session);
    await expect(pool.stats()).resolves.toMatchObject({ idleSessions: 0 });
  });

  it("replaces a bad session with acquireFresh, even with a single slot", async () => {
    const pool = new SessionPool(testClient(), { proxies: [proxy.url], maxSessions: 1 });
    const bad = await pool.acquire();
    using fresh = await pool.acquireFresh(bad);
    expect(fresh.session).not.toBe(bad.session);
    expect((await fresh.session.get(serverUrl("/get"))).status).toBe(200);
  });

  it("runs the client's middleware on leased sessions", async () => {
    const tag: Middleware = {
      onRequest: (request) => {
        request.headers.push(["x-pool", "1"]);
        return request;
      },
    };
    const pool = new SessionPool(testClient({ middleware: [tag] }), { proxies: [proxy.url] });
    using lease = await pool.acquire();
    const res = await lease.session.get(serverUrl("/headers"));
    const { headers } = await res.json<{ headers: Record<string, string> }>();
    expect(headers["X-Pool"]).toBe("1");
  });

  it("accepts bad-proxy detection and health checks", async () => {
    const local = new URL(server.url);
    const pool = new SessionPool(testClient(), {
      proxies: [proxy.url],
      badProxy: { failureThreshold: 2, window: 1_000, cooldown: 1_000, maxCooldowns: 1 },
      healthCheck: {
        interval: 60_000,
        timeout: 1_000,
        targetHost: local.hostname,
        targetPort: Number(local.port),
      },
    });
    using lease = await pool.acquire();
    expect((await lease.session.get(serverUrl("/get"))).status).toBe(200);
  });

  it("stops leasing a proxy that was marked bad often enough", async () => {
    const other = await startConnectProxy();
    try {
      const pool = new SessionPool(testClient(), {
        proxies: [proxy.url, other.url],
        maxSessions: 1,
        badProxy: { failureThreshold: 1, cooldown: 60_000 },
      });
      const first = await pool.acquire();
      first.markBad();
      first.release();
      const before = proxy.targets.length;
      for (let i = 0; i < 3; i++) {
        using lease = await pool.acquire();
        await lease.session.get(serverUrl("/get"));
      }
      // Every session went through the proxy that was not marked.
      expect(proxy.targets.length).toBe(before);
    } finally {
      await other.close();
    }
  });

  it("waits while every proxy cools down instead of handing out a direct session", async () => {
    const pool = new SessionPool(testClient(), {
      proxies: [proxy.url],
      maxSessions: 2,
      badProxy: { failureThreshold: 1, cooldown: 500 },
    });
    const first = await pool.acquire();
    first.markBad();
    first.release();
    const started = Date.now();
    using lease = await pool.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    const before = proxy.targets.length;
    await lease.session.get(serverUrl("/get"));
    expect(proxy.targets.length).toBe(before + 1);
  });

  it("stops waiting when the signal aborts", async () => {
    const pool = new SessionPool(testClient(), {
      proxies: [proxy.url],
      badProxy: { failureThreshold: 1, cooldown: 60_000 },
    });
    const first = await pool.acquire();
    first.markBad();
    first.release();
    const waiting = pool.acquire({ signal: AbortSignal.timeout(200) });
    await expect(waiting).rejects.toBeInstanceOf(AbortError);
    const fresh = pool.acquireFresh(await new SessionPool(testClient()).acquire(), {
      signal: AbortSignal.timeout(200),
    });
    await expect(fresh).rejects.toBeInstanceOf(AbortError);
  });

  it("accepts chains and rejects invalid options", () => {
    expect(
      () =>
        new SessionPool(testClient(), {
          proxies: [proxy.url, "socks5://127.0.0.1:1"],
          idleTimeout: 1_000,
          rotation: "random",
        }),
    ).not.toThrow();
    expectInvalidConfig(
      () => new SessionPool(testClient(), { proxies: [proxy.url], rotation: "x" as "random" }),
    );
    expectInvalidConfig(() => new SessionPool(testClient(), { proxies: ["nope"] }));
    expectInvalidConfig(
      () => new SessionPool(testClient(), { proxies: [proxy.url], badProxy: { window: -1 } }),
    );
    expectInvalidConfig(
      () =>
        new SessionPool(testClient(), {
          proxies: [proxy.url],
          healthCheck: { interval: Number.NaN },
        }),
    );
  });
});

describe("SessionPool with a proxy function", () => {
  let proxy: TestProxy;

  beforeAll(async () => {
    proxy = await startConnectProxy();
  });

  afterAll(async () => {
    await proxy.close();
  });

  it("binds every new session to the proxy the function makes up", async () => {
    let calls = 0;
    const pool = new SessionPool(testClient(), {
      proxies: () => {
        calls += 1;
        return proxy.url;
      },
      maxSessions: 2,
    });
    const before = proxy.targets.length;
    using lease = await pool.acquire();
    expect((await lease.session.get(serverUrl("/get"))).status).toBe(200);
    expect(proxy.targets.length).toBe(before + 1);
    expect(calls).toBe(1);
  });

  it("asks only when it needs a new session, not when it reuses an idle one", async () => {
    let calls = 0;
    const pool = new SessionPool(testClient(), {
      proxies: async () => {
        calls += 1;
        return ProxyConfig.parse(proxy.url);
      },
      maxSessions: 1,
    });
    const first = await pool.acquire();
    first.release();
    await expect(idleSoon(pool, 1)).resolves.toBe(1);
    using second = await pool.acquire();
    expect(second).toBeInstanceOf(SessionLease);
    expect(calls).toBe(1);
  });

  it("keeps asking a failing function, and builds no session without a proxy meanwhile", async () => {
    let calls = 0;
    let healthy = false;
    const pool = new SessionPool(testClient(), {
      proxies: () => {
        calls += 1;
        if (!healthy) throw new Error("gateway is down");
        return proxy.url;
      },
      maxSessions: 1,
    });
    const error = await pool
      .acquire({ signal: AbortSignal.timeout(500) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AbortError);
    expect(calls).toBeGreaterThanOrEqual(2);
    await expect(pool.stats()).resolves.toMatchObject({ idleSessions: 0 });
    healthy = true;
    const before = proxy.targets.length;
    using lease = await pool.acquire();
    await lease.session.get(serverUrl("/get"));
    expect(proxy.targets.length).toBe(before + 1);
  });

  it("makes proxies up ahead of time with proxyBuffer", async () => {
    let calls = 0;
    const pool = new SessionPool(testClient(), {
      proxies: () => {
        calls += 1;
        return proxy.url;
      },
      proxyBuffer: 2,
    });
    await waitFor(() => calls >= 2);
    using lease = await pool.acquire();
    expect((await lease.session.get(serverUrl("/get"))).status).toBe(200);
  });

  it("refuses the options a list needs, and a buffer a list cannot use", () => {
    const source = (): string => proxy.url;
    expectInvalidConfig(
      () => new SessionPool(testClient(), { proxies: source, rotation: "random" }),
    );
    expectInvalidConfig(
      () => new SessionPool(testClient(), { proxies: source, badProxy: { cooldown: 1_000 } }),
    );
    expectInvalidConfig(
      () => new SessionPool(testClient(), { proxies: [proxy.url], proxyBuffer: 2 }),
    );
  });
});
