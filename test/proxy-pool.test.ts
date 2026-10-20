import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AbortError,
  ProxyConfig,
  ProxyLease,
  ProxyPool,
  type ProxySource,
  pendingRequests,
} from "../src/index.js";
import { server, serverUrl, testClient } from "./support/clients.js";
import { expectInvalidConfig, waitFor } from "./support/helpers.js";
import { startConnectProxy, type TestProxy } from "./support/proxies.js";

const proxies = ["http://p1.example:8080", "http://p2.example:8080", "http://p3.example:8080"];
const identities = proxies.map((url) => ProxyConfig.parse(url).identity);

describe("ProxyPool", () => {
  it("leases proxies round robin", async () => {
    const pool = new ProxyPool(proxies);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      using lease = await pool.acquire();
      expect(lease).toBeInstanceOf(ProxyLease);
      expect(lease.proxy).toBeInstanceOf(ProxyConfig);
      seen.push(lease.proxy?.identity ?? "");
    }
    expect(seen).toEqual([...identities, identities[0]]);
  });

  it("leases from every proxy with random rotation", async () => {
    const pool = new ProxyPool(proxies, { rotation: "random" });
    const seen = new Set<string>();
    for (let i = 0; i < 60 && seen.size < 3; i++) {
      const lease = await pool.acquire();
      seen.add(lease.proxy?.identity ?? "");
      lease.release();
    }
    expect(seen).toEqual(new Set(identities));
  });

  it("skips a proxy marked bad, through the lease or by identity", async () => {
    const pool = new ProxyPool(proxies, { badProxy: { failureThreshold: 1, cooldown: 60_000 } });
    const first = await pool.acquire();
    first.markBad();
    first.release();
    pool.markBad(identities[1] ?? "");
    // The marks take effect before markBad() returns.
    for (let i = 0; i < 3; i++) {
      using lease = await pool.acquire();
      expect(lease.proxy?.identity).toBe(identities[2]);
    }
  });

  it("waits while every proxy cools down, and leases the first one back", async () => {
    const pool = new ProxyPool(proxies.slice(0, 1), {
      badProxy: { failureThreshold: 1, cooldown: 500 },
    });
    const first = await pool.acquire();
    first.markBad();
    first.release();
    const started = Date.now();
    using lease = await pool.acquire();
    // Never a lease without a proxy, which would connect directly.
    expect(lease.proxy?.identity).toBe(identities[0]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("stops waiting when the signal aborts, before or during the wait", async () => {
    const pool = new ProxyPool(proxies.slice(0, 1), {
      badProxy: { failureThreshold: 1, cooldown: 60_000 },
    });
    pool.markBad(identities[0] ?? "");
    const reason = new Error("no longer needed");
    const early = await pool
      .acquire({ signal: AbortSignal.abort(reason) })
      .catch((caught: unknown) => caught);
    expect(early).toBeInstanceOf(AbortError);
    expect((early as Error).cause).toBe(reason);
    const late = pool.acquire({ signal: AbortSignal.timeout(200) });
    await expect(late).rejects.toBeInstanceOf(AbortError);
    await waitFor(() => pendingRequests() === 0);
  });

  it("leases no proxy only from a pool without any", async () => {
    using lease = await new ProxyPool([]).acquire();
    expect(lease.proxy).toBeNull();
  });

  it("reports how many proxies can be leased out at once, 100 unless told otherwise", () => {
    expect(new ProxyPool(proxies).maxConcurrent).toBe(100);
    expect(new ProxyPool(proxies, { maxConcurrent: 2 }).maxConcurrent).toBe(2);
  });

  it("makes acquire wait for a free slot", async () => {
    const pool = new ProxyPool(proxies, { maxConcurrent: 1 });
    const held = await pool.acquire();
    let granted = false;
    const waiting = pool.acquire().then((lease) => {
      granted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(granted).toBe(false);
    held.release();
    (await waiting).release();
    expect(granted).toBe(true);
  });

  it("replaces a lease with acquireFresh, even with a single slot", async () => {
    const pool = new ProxyPool(proxies, { maxConcurrent: 1 });
    const bad = await pool.acquire();
    using fresh = await pool.acquireFresh(bad);
    expect(fresh.proxy?.identity).toBe(identities[1]);
    // The old lease gave its slot up: releasing it again does nothing.
    bad.release();
    expect(bad.proxy).not.toBeNull();
  });

  it("counts the failure acquireFresh reports against the proxy", async () => {
    const pool = new ProxyPool(proxies, { badProxy: { failureThreshold: 1, cooldown: 60_000 } });
    const bad = await pool.acquire();
    const fresh = await pool.acquireFresh(bad);
    fresh.release();
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      using lease = await pool.acquire();
      seen.add(lease.proxy?.identity ?? "");
    }
    expect(seen).not.toContain(identities[0]);
  });

  it("accepts ProxyConfig values, limits and health checks", () => {
    const local = new URL(server.url);
    expect(
      () =>
        new ProxyPool([ProxyConfig.parse(proxies[0] ?? ""), ...proxies], {
          maxConcurrent: 2,
          badProxy: { failureThreshold: 2, window: 1_000, cooldown: 1_000, maxCooldowns: 1 },
          healthCheck: {
            interval: 60_000,
            timeout: 1_000,
            targetHost: local.hostname,
            targetPort: Number(local.port),
          },
        }),
    ).not.toThrow();
  });

  it("rejects an unknown rotation or an invalid proxy", () => {
    expectInvalidConfig(() => new ProxyPool(proxies, { rotation: "lru" as "random" }));
    expectInvalidConfig(() => new ProxyPool(["not a proxy"]));
  });

  it("releases leases idempotently and does not count them in flight", async () => {
    const pool = new ProxyPool(proxies);
    const lease = await pool.acquire();
    await waitFor(() => pendingRequests() === 0);
    lease.release();
    lease.release();
    expect(lease.proxy).not.toBeNull();
  });
});

describe("leased proxies in use", () => {
  let proxy: TestProxy;

  beforeAll(async () => {
    proxy = await startConnectProxy();
  });

  afterAll(async () => {
    await proxy.close();
  });

  it("routes a session through the leased proxy", async () => {
    const pool = new ProxyPool([proxy.url]);
    using lease = await pool.acquire();
    const res = await testClient()
      .session({ proxy: lease.proxy ?? undefined })
      .get(serverUrl("/get"));
    expect(res.status).toBe(200);
    expect(proxy.targets).toHaveLength(1);
  });
});

describe("ProxyPool with a proxy function", () => {
  /** Hands out `http://gw<n>.example:8080` for n = 1, 2, ...; `calls` counts the asks. */
  function gateway(): { source: ProxySource; calls: () => number } {
    let calls = 0;
    return {
      source: () => `http://gw${++calls}.example:8080`,
      calls: () => calls,
    };
  }

  it("asks the function once per lease and leases what it returns", async () => {
    const { source, calls } = gateway();
    const pool = new ProxyPool(source);
    const hosts: string[] = [];
    for (let i = 0; i < 3; i++) {
      using lease = await pool.acquire();
      hosts.push(lease.proxy?.host ?? "");
    }
    expect(hosts).toEqual(["gw1.example", "gw2.example", "gw3.example"]);
    expect(calls()).toBe(3);
  });

  it("takes ProxyConfig objects, chains included, and async functions", async () => {
    const chain = ProxyConfig.chain(["http://hop.example:1", "socks5://last.example:2"]);
    const withChain = new ProxyPool(async () => chain);
    using lease = await withChain.acquire();
    expect([lease.proxy?.hopCount, lease.proxy?.host]).toEqual([2, "last.example"]);
    const credentialed = ProxyConfig.parse("http://gw.example:1").withCustomAuth({
      identity: "from-function",
      authorize: () => "Bearer x",
    });
    using second = await new ProxyPool(() => credentialed).acquire();
    expect(second.proxy?.identity).toBe(credentialed.identity);
  });

  it("limits the leases out at once, and counts nothing for the function", async () => {
    const { source } = gateway();
    const pool = new ProxyPool(source, { maxConcurrent: 1 });
    const held = await pool.acquire();
    let granted = false;
    const waiting = pool.acquire().then((lease) => {
      granted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(granted).toBe(false);
    held.markBad(); // nothing is tracked per proxy: made-up proxies are all different
    held.release();
    (await waiting).release();
    expect(granted).toBe(true);
  });

  it("asks a failing function again until it gives a proxy", async () => {
    let calls = 0;
    const pool = new ProxyPool(() => {
      if (++calls <= 2) throw new Error("gateway is down");
      return "http://gw.example:8080";
    });
    using lease = await pool.acquire();
    expect(lease.proxy?.host).toBe("gw.example");
    expect(calls).toBe(3);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("gateway is down");
      },
    ],
    ["returns a number", () => 5],
    ["returns nothing", () => undefined],
    ["returns a URL that is no proxy", () => "not a proxy"],
    ["returns a promise that rejects", () => Promise.reject(new Error("nope"))],
  ])("keeps waiting while the function %s, until the signal aborts", async (_, failing) => {
    let healthy = false;
    let calls = 0;
    const pool = new ProxyPool(
      () => {
        calls++;
        return healthy ? "http://gw.example:8080" : (failing as () => string)();
      },
      { maxConcurrent: 1 },
    );
    const error = await pool
      .acquire({ signal: AbortSignal.timeout(500) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AbortError);
    expect(calls).toBeGreaterThanOrEqual(2);
    // The abandoned wait gave the only slot back.
    healthy = true;
    using lease = await pool.acquire();
    expect(lease.proxy?.host).toBe("gw.example");
  });

  it("stops acquireFresh with its signal too", async () => {
    const pool = new ProxyPool(() => {
      throw new Error("gateway is down");
    });
    const bad = await new ProxyPool(["http://a.example:1"]).acquire();
    const fresh = pool.acquireFresh(bad, { signal: AbortSignal.timeout(200) });
    await expect(fresh).rejects.toBeInstanceOf(AbortError);
  });

  it("makes proxies up ahead of time with proxyBuffer, and keeps the buffer full", async () => {
    const { source, calls } = gateway();
    const pool = new ProxyPool(source, { proxyBuffer: 3 });
    await waitFor(() => calls() >= 3);
    expect(calls()).toBe(3);
    using first = await pool.acquire();
    // Taking one makes room for another, and the proxies come in the order they were made.
    expect(first.proxy?.host).toBe("gw1.example");
    await waitFor(() => calls() >= 4);
    using second = await pool.acquire();
    expect(second.proxy?.host).toBe("gw2.example");
    await waitFor(() => calls() >= 5);
    expect(calls()).toBe(5);
  });

  it("retries filling the buffer after a failure", async () => {
    let calls = 0;
    const pool = new ProxyPool(
      () => {
        if (++calls === 1) throw new Error("warming up");
        return `http://gw${calls}.example:8080`;
      },
      { proxyBuffer: 1 },
    );
    // The first attempt fails; the buffer task asks again after a second.
    await waitFor(() => calls >= 2, 4_000);
    using lease = await pool.acquire();
    expect(lease.proxy?.host).toBe("gw2.example");
  });

  it("refuses the options a list needs, and a buffer a list cannot use", () => {
    const { source } = gateway();
    expectInvalidConfig(() => new ProxyPool(source, { rotation: "random" }));
    expectInvalidConfig(() => new ProxyPool(source, { badProxy: { failureThreshold: 1 } }));
    expectInvalidConfig(() => new ProxyPool(source, { healthCheck: { interval: 1_000 } }));
    expectInvalidConfig(() => new ProxyPool(proxies, { proxyBuffer: 2 }));
    expectInvalidConfig(() => new ProxyPool(source, { proxyBuffer: -1 }));
  });
});
