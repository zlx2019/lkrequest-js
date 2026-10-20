import { createServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client,
  type LogRecord,
  onLog,
  ProxyConfig,
  ProxyError,
  pendingRequests,
  setLogLevel,
  TimeoutError,
} from "../src/index.js";
import { server, serverUrl, testClient } from "./support/clients.js";
import { startDnsServer, TEST_DOMAIN } from "./support/dns-server.js";
import { closedPort, expectInvalidConfig, waitFor } from "./support/helpers.js";
import { startConnectProxy, startSocks5Proxy, type TestProxy } from "./support/proxies.js";

const port = Number(new URL(server.url).port);
const origin = `127.0.0.1:${port}`;

describe("ProxyConfig", () => {
  it("parses a single proxy and keeps the password out of every description", () => {
    // Test passwords stay under 4 characters: the public-release sanitizer rewrites longer ones.
    const proxy = ProxyConfig.parse("socks5://someone:s3c@proxy.example.com:1080");
    expect(proxy.hopCount).toBe(1);
    expect(proxy.toString()).toBe("socks5://proxy.example.com:1080");
    const [hop] = JSON.parse(proxy.identity) as unknown[][];
    expect(hop?.slice(0, 3)).toEqual(["socks5", "proxy.example.com", 1080]);
    expect(String(hop?.[3])).toContain("someone");
    expect(proxy.identity).not.toContain("s3c");
  });

  it("builds chains in order", () => {
    const chain = ProxyConfig.chain([
      "socks5://hop1.example:1080",
      "socks5h://hop2.example:1081",
      "http://final.example:8080",
    ]);
    expect(chain.hopCount).toBe(3);
    expect(chain.toString()).toBe(
      "socks5://hop1.example:1080 -> socks5h://hop2.example:1081 -> http://final.example:8080",
    );
    expect(JSON.parse(chain.identity)).toEqual([
      ["socks5", "hop1.example", 1080, null],
      ["socks5h", "hop2.example", 1081, null],
      ["http", "final.example", 8080, null],
    ]);
  });

  it("returns new configurations from through() and the credential setters", () => {
    const final = ProxyConfig.parse("socks5://final.example:1080");
    const chain = final.through([
      "http://hop1.example:8080",
      ProxyConfig.parse("socks5://hop2.example:1081"),
    ]);
    expect(final.hopCount).toBe(1);
    expect(chain.hopCount).toBe(3);
    expect(chain.toString()).toMatch(/^http:\/\/hop1\.example:8080 -> socks5:\/\/hop2/);
    const plain = ProxyConfig.parse("http://proxy.example:8080");
    const bearer = plain.withHttpAuth("Bearer", "token-123");
    expect(bearer).not.toBe(plain);
    expect((JSON.parse(plain.identity) as unknown[][])[0]?.[3]).toBeNull();
    expect(bearer.withAuthHeader("authorization")).not.toBe(bearer);
  });

  it("tells routes apart by DNS mode and by credential", () => {
    expect(ProxyConfig.parse("socks5://hop.example:1080").identity).not.toBe(
      ProxyConfig.parse("socks5h://hop.example:1080").identity,
    );
    const proxy = ProxyConfig.parse("http://proxy.example:8080");
    const first = proxy.withHttpAuth("Bearer", "token-one").identity;
    expect(first).not.toBe(proxy.withHttpAuth("Bearer", "token-two").identity);
    expect(first).not.toContain("token-one");
    const replaced = ProxyConfig.parse("http://old:secret@proxy.example:8080").withUserPass(
      "new",
      "pw",
    );
    const [hop] = JSON.parse(replaced.identity) as unknown[][];
    expect(String(hop?.[3])).toContain("new");
    expect(String(hop?.[3])).not.toContain("old");
  });

  it("reports the proxy the client talks to last, and whether it may be bypassed", () => {
    const cases: Array<[string, string, number, boolean]> = [
      ["http://proxy.example", "proxy.example", 80, false],
      ["http://proxy.example:3128", "proxy.example", 3128, false],
      ["socks5h://user:pw@hop.example", "hop.example", 1080, false],
      ["socks5://[::1]:1080", "[::1]", 1080, false],
      ["masque://masque.example", "masque.example", 443, true],
      ["masque://masque.example:8443", "masque.example", 8443, true],
    ];
    for (const [url, host, port, forbidsDirectFallback] of cases) {
      const proxy = ProxyConfig.parse(url);
      expect([proxy.host, proxy.port, proxy.forbidsDirectFallback]).toEqual([
        host,
        port,
        forbidsDirectFallback,
      ]);
    }
    // A chain is described by its final hop, the one that connects to the target.
    const chain = ProxyConfig.chain(["http://first.example:1", "socks5://last.example:2"]);
    expect([chain.host, chain.port, chain.forbidsDirectFallback]).toEqual([
      "last.example",
      2,
      false,
    ]);
  });

  it("rejects what cannot be a proxy", () => {
    expectInvalidConfig(() => ProxyConfig.parse("ftp://proxy.example:21"));
    expectInvalidConfig(() => ProxyConfig.chain([]));
    expectInvalidConfig(() =>
      ProxyConfig.parse("socks5://proxy.example:1080").withHttpAuth("Bearer", "token"),
    );
    expectInvalidConfig(() =>
      ProxyConfig.parse("http://proxy.example:8080").withAuthHeader(
        "x-proxy-token" as "authorization",
      ),
    );
    expectInvalidConfig(() => testClient().session({ proxy: "not a proxy" }));
  });

  it("refuses an invalid per-request proxy instead of connecting directly", async () => {
    await expect(
      testClient().session().get(serverUrl("/get"), { proxy: "nonsense" }),
    ).rejects.toMatchObject({ code: "ERR_LK_INVALID_CONFIG" });
  });
});

describe("requests through proxies", () => {
  let http: TestProxy;
  let socks: TestProxy;

  beforeAll(async () => {
    http = await startConnectProxy();
    socks = await startSocks5Proxy();
  });

  afterAll(async () => {
    await Promise.all([http.close(), socks.close()]);
  });

  it("tunnels through an HTTP CONNECT proxy", async () => {
    const before = http.targets.length;
    const res = await testClient().session({ proxy: http.url }).get(serverUrl("/get"));
    expect(res.status).toBe(200);
    expect(http.targets.slice(before)).toEqual([origin]);
  });

  it("tunnels through a SOCKS5 proxy, resolving names locally or remotely", async () => {
    const url = `https://localhost:${port}/get`;
    // family 4, because localhost may resolve to ::1 first and the server is IPv4 only.
    const local = await testClient({ family: 4 }).session({ proxy: socks.url }).get(url);
    expect(local.status).toBe(200);
    expect(socks.targets.at(-1)).toBe(origin);
    const remote = await testClient()
      .session({ proxy: socks.url.replace("socks5:", "socks5h:") })
      .get(url);
    expect(remote.status).toBe(200);
    expect(socks.targets.at(-1)).toBe(`localhost:${port}`);
  });

  it("routes one request through a proxy the session does not use", async () => {
    const before = http.targets.length;
    const session = testClient().session();
    await session.get(serverUrl("/get"), { proxy: http.url });
    await session.get(serverUrl("/get"));
    expect(http.targets.length - before).toBe(1);
  });

  it("follows a chain hop by hop", async () => {
    const chain = ProxyConfig.chain([http.url, socks.url]);
    const httpBefore = http.targets.length;
    const socksBefore = socks.targets.length;
    const res = await testClient().session({ proxy: chain }).get(serverUrl("/get"));
    expect(res.status).toBe(200);
    expect(http.targets.slice(httpBefore)).toEqual([`127.0.0.1:${socks.port}`]);
    expect(socks.targets.slice(socksBefore)).toEqual([origin]);
  });
});

describe("proxy credentials", () => {
  // Test passwords stay under 4 characters: the public-release sanitizer rewrites longer ones.
  const credentials = { username: "user", password: "pwd" };
  let http: TestProxy;
  let socks: TestProxy;

  beforeAll(async () => {
    http = await startConnectProxy(credentials);
    socks = await startSocks5Proxy(credentials);
  });

  afterAll(async () => {
    await Promise.all([http.close(), socks.close()]);
  });

  it("sends Basic credentials from the URL or withUserPass", async () => {
    const inUrl = http.url.replace("http://", "http://user:pwd@");
    expect((await testClient().session({ proxy: inUrl }).get(serverUrl("/get"))).status).toBe(200);
    const set = ProxyConfig.parse(http.url).withUserPass("user", "pwd");
    expect((await testClient().session({ proxy: set }).get(serverUrl("/get"))).status).toBe(200);
  });

  it("fails with ProxyError when the proxy rejects the credentials", async () => {
    const wrong = ProxyConfig.parse(http.url).withUserPass("user", "wrong");
    await expect(
      testClient().session({ proxy: wrong }).get(serverUrl("/get"), { timeout: 5_000 }),
    ).rejects.toBeInstanceOf(ProxyError);
  });

  it.each([
    [503, "proxy CONNECT failed after authentication retry (status 503)"],
    [407, "proxy authentication failed after retry (status 407)"],
  ])(
    "reports a %i to the retry after a Basic challenge by that status",
    async (status, message) => {
      // Challenging a CONNECT that carried credentials makes the client connect again and retry
      // once with them.
      const sent: Array<string | undefined> = [];
      const sockets = new Set<Socket>();
      const challenging = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => socket.destroy());
        socket.once("data", (head: Buffer) => {
          sent.push(/^proxy-authorization:\s*([^\r\n]*)/im.exec(head.toString("latin1"))?.[1]);
          socket.end(
            sent.length === 1
              ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\nContent-Length: 0\r\n\r\n'
              : `HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`,
          );
        });
      });
      await new Promise<void>((resolve) => challenging.listen(0, "127.0.0.1", resolve));
      try {
        const { port: proxyPort } = challenging.address() as { port: number };
        const proxy = ProxyConfig.parse(`http://127.0.0.1:${proxyPort}`).withUserPass(
          "user",
          "pwd",
        );
        const request = testClient().session({ proxy }).get(serverUrl("/get"), { timeout: 5_000 });
        await expect(request).rejects.toBeInstanceOf(ProxyError);
        await expect(request).rejects.toThrow(message);
        const basic = `Basic ${Buffer.from("user:pwd").toString("base64")}`;
        expect(sent).toEqual([basic, basic]);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => challenging.close(resolve));
      }
    },
  );

  it.each([
    [undefined, "proxy-authorization"],
    ["authorization", "authorization"],
  ] as const)("sends an HTTP credential in the %s header", async (header, expected) => {
    let proxy = ProxyConfig.parse(http.url).withHttpAuth("Bearer", "token-123");
    if (header) proxy = proxy.withAuthHeader(header);
    await expect(
      testClient().session({ proxy }).get(serverUrl("/get"), { timeout: 5_000 }),
    ).rejects.toBeInstanceOf(ProxyError);
    expect(http.headers.at(-1)?.[expected]).toBe("Bearer token-123");
  });

  it("authenticates to a SOCKS5 proxy with a user name and password", async () => {
    const proxy = socks.url.replace("socks5://", "socks5://user:pwd@");
    expect((await testClient().session({ proxy }).get(serverUrl("/get"))).status).toBe(200);
  });
});

describe("ProxyConfig#withCustomAuth", () => {
  const credentials = { username: "user", password: "pwd" };
  const basic = `Basic ${Buffer.from("user:pwd").toString("base64")}`;
  const target = { host: "127.0.0.1", port };
  let strict: TestProxy;
  let open: TestProxy;

  beforeAll(async () => {
    strict = await startConnectProxy(credentials);
    open = await startConnectProxy();
  });

  afterAll(async () => {
    await Promise.all([strict.close(), open.close()]);
  });

  it("sends the header the function returns, on every connection", async () => {
    let calls = 0;
    const proxy = ProxyConfig.parse(strict.url).withCustomAuth({
      identity: "static-basic",
      authorize: () => {
        calls += 1;
        return basic;
      },
    });
    await expect(proxy.healthCheck(target)).resolves.toBeGreaterThanOrEqual(0);
    const first = calls;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(strict.headers.at(-1)?.["proxy-authorization"]).toBe(basic);
    await proxy.healthCheck(target);
    expect(calls).toBeGreaterThan(first);
  });

  it("awaits an async function, and works for requests through a session", async () => {
    const proxy = ProxyConfig.parse(strict.url).withCustomAuth({
      identity: "async-basic",
      authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return basic;
      },
    });
    const res = await testClient().session({ proxy }).get(serverUrl("/get"));
    expect(res.status).toBe(200);
  });

  it("sends it in the header withAuthHeader picks", async () => {
    const proxy = ProxyConfig.parse(open.url)
      .withCustomAuth({ identity: "bearer", authorize: () => "Bearer abc" })
      .withAuthHeader("authorization");
    await proxy.healthCheck(target);
    expect(open.headers.at(-1)).toMatchObject({ authorization: "Bearer abc" });
  });

  it("sends no credential for null, and the proxy refuses the tunnel", async () => {
    const proxy = ProxyConfig.parse(strict.url).withCustomAuth({
      identity: "nothing",
      authorize: () => null,
    });
    await expect(proxy.healthCheck(target)).rejects.toBeInstanceOf(ProxyError);
  });

  it("logs a function that throws, and connects without a credential", async () => {
    const records: LogRecord[] = [];
    const unsubscribe = onLog((record) => records.push(record));
    setLogLevel("lkrequest_napi=warn");
    try {
      const proxy = ProxyConfig.parse(strict.url).withCustomAuth({
        identity: "broken",
        authorize: () => {
          throw new Error("vault is sealed");
        },
      });
      await expect(proxy.healthCheck(target)).rejects.toBeInstanceOf(ProxyError);
      await waitFor(() =>
        records.some((record) => /credential function failed/.test(record.message)),
      );
      const failed = records.find((record) => /credential function failed/.test(record.message));
      expect(failed?.fields.error).toMatch(/vault is sealed/);
      expect(failed?.fields.identity).toBe("broken");
    } finally {
      setLogLevel("off");
      unsubscribe();
    }
  });

  it("puts the identity in the proxy's identity, and replaces other credentials", () => {
    const plain = ProxyConfig.parse("http://old:secret@proxy.example:8080");
    const custom = plain.withCustomAuth({ identity: "signer-1", authorize: () => "Bearer x" });
    const [hop] = JSON.parse(custom.identity) as unknown[][];
    expect(hop?.[3]).toBe("custom:signer-1");
    expect(custom.identity).not.toContain("old");
    const other = plain.withCustomAuth({ identity: "signer-2", authorize: () => "Bearer x" });
    expect(other.identity).not.toBe(custom.identity);
  });

  it("is refused by a SOCKS5 proxy, which has no header to put it in", () => {
    expectInvalidConfig(() =>
      ProxyConfig.parse("socks5://proxy.example:1080").withCustomAuth({
        identity: "nope",
        authorize: () => "Bearer x",
      }),
    );
  });
});

describe("proxy failures", () => {
  it("falls back to a direct connection only with fallback.proxyToDirect", async () => {
    const proxy = `http://127.0.0.1:${await closedPort()}`;
    await expect(
      testClient().session({ proxy }).get(serverUrl("/get"), { timeout: 5_000 }),
    ).rejects.toBeInstanceOf(ProxyError);
    const fallback = testClient({ fallback: { proxyToDirect: true } }).session({ proxy });
    expect((await fallback.get(serverUrl("/get"))).status).toBe(200);
  });

  it("applies family to the proxy address and never falls back past it", async () => {
    const proxy = `http://[::1]:${await closedPort()}`;
    const session = testClient({ family: 4, fallback: { proxyToDirect: true } }).session({
      proxy,
    });
    await expect(session.get(serverUrl("/get"))).rejects.toThrow(/IPv4 policy/);
  });

  it("hands an HTTP CONNECT proxy the connectTo address instead of the name", async () => {
    const http = await startConnectProxy();
    try {
      const client = new Client({
        tls: { rejectUnauthorized: false },
        family: 4,
        connectTo: { [`connect-to.test:${port}`]: origin },
      });
      const res = await client
        .session({ proxy: http.url })
        .get(`https://connect-to.test:${port}/get`, { timeout: 5_000 });
      expect(res.status).toBe(200);
      expect(http.targets).toEqual([origin]);
    } finally {
      await http.close();
    }
  });
});

describe("ProxyConfig#healthCheck", () => {
  let http: TestProxy;
  let socks: TestProxy;
  let refusing: TestProxy;
  const target = { host: "127.0.0.1", port };

  beforeAll(async () => {
    http = await startConnectProxy();
    socks = await startSocks5Proxy();
    refusing = await startConnectProxy({ username: "someone", password: "pwd" });
  });

  afterAll(async () => {
    await Promise.all([http.close(), socks.close(), refusing.close()]);
  });

  it("measures the time to open a tunnel through an HTTP or a SOCKS5 proxy", async () => {
    for (const proxy of [http, socks]) {
      const latency = await ProxyConfig.parse(proxy.url).healthCheck(target);
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThan(5_000);
      expect(proxy.targets).toContain(origin);
    }
  });

  it("goes through every hop of a chain", async () => {
    const socksBefore = socks.targets.length;
    const latency = await ProxyConfig.chain([http.url, socks.url]).healthCheck(target);
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(socks.targets.slice(socksBefore)).toEqual([origin]);
  });

  it("is not a request in flight once it has resolved", async () => {
    await ProxyConfig.parse(http.url).healthCheck(target);
    expect(pendingRequests()).toBe(0);
  });

  it("rejects with ProxyError when the proxy cannot be reached", async () => {
    const proxy = ProxyConfig.parse(`http://127.0.0.1:${await closedPort()}`);
    // Windows reports a refused connection only after about two seconds.
    await expect(proxy.healthCheck({ ...target, timeout: 10_000 })).rejects.toBeInstanceOf(
      ProxyError,
    );
  });

  it("rejects with ProxyError when the proxy refuses the tunnel", async () => {
    // The proxy wants credentials this configuration does not have.
    const proxy = ProxyConfig.parse(refusing.url);
    await expect(proxy.healthCheck(target)).rejects.toBeInstanceOf(ProxyError);
    const authorized = proxy.withUserPass("someone", "pwd");
    await expect(authorized.healthCheck(target)).resolves.toBeGreaterThanOrEqual(0);
  });

  it("rejects with TimeoutError when the proxy does not answer in time", async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const { port: silentPort } = silent.address() as { port: number };
      const proxy = ProxyConfig.parse(`http://127.0.0.1:${silentPort}`);
      await expect(proxy.healthCheck({ ...target, timeout: 200 })).rejects.toBeInstanceOf(
        TimeoutError,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("rejects a MASQUE proxy, which relays UDP only", async () => {
    const proxy = ProxyConfig.parse("masque://127.0.0.1:1");
    await expect(proxy.healthCheck({ ...target, timeout: 1_000 })).rejects.toThrow(ProxyError);
    await expect(proxy.healthCheck({ ...target, timeout: 1_000 })).rejects.toThrow(
      /relays UDP only/,
    );
  });

  it("resolves names with the client's DNS settings when given one", async () => {
    const name = `probe.${TEST_DOMAIN}`;
    const dns = await startDnsServer({ [name]: "127.0.0.1" });
    try {
      // socks5:// resolves the target on the client side, so the address the proxy is asked
      // for can only come from the test DNS server.
      const client = new Client({ dns: { server: dns.address }, family: 4 });
      const before = socks.targets.length;
      await ProxyConfig.parse(socks.url).healthCheck({ host: name, port, client });
      expect(socks.targets.slice(before)).toEqual([origin]);
      expect(dns.queries).toContainEqual({ name, type: 1 });
    } finally {
      await dns.close();
    }
  });

  it("rejects timing that is not a duration", async () => {
    const proxy = ProxyConfig.parse(http.url);
    await expect(proxy.healthCheck({ ...target, timeout: -1 })).rejects.toMatchObject({
      name: "TypeError",
      code: "ERR_LK_INVALID_CONFIG",
    });
  });
});
