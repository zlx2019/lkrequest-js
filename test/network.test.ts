import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { afterAll, describe, expect, it } from "vitest";
import { Client, ConnectionError, RequestError, TimeoutError } from "../src/index.js";
import { server, serverUrl, testClient } from "./support/clients.js";
import { startDnsServer, TEST_DOMAIN, type TestDnsServer } from "./support/dns-server.js";
import { expectInvalidConfig } from "./support/helpers.js";
import { startConnectProxy } from "./support/proxies.js";

/** The test server's port; it listens on 127.0.0.1 only. */
const port = Number(new URL(server.url).port);

/** Whether `localhost` resolves to both loopback addresses, making family choice observable. */
const dualStackLocalhost = await lookup("localhost", { all: true }).then(
  (addresses) => {
    const found = new Set(addresses.map(({ address }) => address));
    return found.has("127.0.0.1") && found.has("::1");
  },
  () => false,
);

describe("dns", () => {
  it.each([
    "system",
    "google",
    "cloudflare",
    "quad9",
    "google_https",
    "cloudflare_https",
    "quad9_https",
  ] as const)("accepts the %s resolver", (dns) => {
    expect(() => new Client({ dns, family: 4 })).not.toThrow();
  });

  it("still requests an IP literal with a DNS-over-HTTPS resolver and a family", async () => {
    const res = await testClient({ dns: "cloudflare_https", family: 4 })
      .session()
      .get(serverUrl("/get"));
    expect(res.status).toBe(200);
  });

  it("caches the system resolver, a zero TTL included", async () => {
    expect(() => new Client({ dnsCache: { ttl: 30_000, maxEntries: 4_096 } })).not.toThrow();
    expect(() => new Client({ dnsCache: { ttl: 0 } })).not.toThrow();
    const client = testClient({ dnsCache: { ttl: 30_000 }, family: 4 });
    const url = new URL("/get", server.url.replace("127.0.0.1", "localhost")).href;
    expect((await client.session().get(url)).status).toBe(200);
  });

  it("rejects a cache next to another resolver, or entries without a TTL", () => {
    expectInvalidConfig(() => new Client({ dns: "google", dnsCache: { ttl: 30_000 } }));
    expectInvalidConfig(
      () => new Client({ dnsCache: { maxEntries: 10 } as unknown as { ttl: number } }),
    );
    expectInvalidConfig(() => new Client({ dns: "opendns" as "google" }));
  });
});

describe("dns server", () => {
  const app = `app.${TEST_DOMAIN}`;
  const appUrl = `https://${app}:${port}/get`;
  const started: TestDnsServer[] = [];

  /** A DNS server that knows `app.lkrequest.test`, stopped after the tests. */
  async function dnsServer(): Promise<TestDnsServer> {
    const dns = await startDnsServer({ [app]: "127.0.0.1" });
    started.push(dns);
    return dns;
  }

  afterAll(async () => {
    await Promise.all(started.map((dns) => dns.close()));
  });

  it.each(["1.1.1.1", "1.1.1.1:5353", "2606:4700:4700::1111", "[2606:4700:4700::1111]:5353"])(
    "accepts the server %s",
    (address) => {
      expect(() => new Client({ dns: { server: address } })).not.toThrow();
    },
  );

  it.each([
    "dns.google",
    "dns.google:53",
    "1.1.1.1:0",
    "1.1.1.1:65536",
    "1.1.1.1:",
    "[2606:4700:4700::1111]",
    "",
  ])("rejects the server %j", (address) => {
    expectInvalidConfig(() => new Client({ dns: { server: address } }));
    expect(() => new Client({ dns: { server: address } })).toThrow(/dns\.server/);
  });

  it("rejects anything else as the dns option", () => {
    expectInvalidConfig(() => new Client({ dns: {} as { server: string } }));
    expectInvalidConfig(() => new Client({ dns: { server: 53 as unknown as string } }));
  });

  it("cannot be combined with the system resolver's cache", () => {
    expectInvalidConfig(
      () => new Client({ dns: { server: "1.1.1.1" }, dnsCache: { ttl: 30_000 } }),
    );
  });

  it("resolves names through the server", async () => {
    const dns = await dnsServer();
    const client = testClient({ dns: { server: dns.address } });
    const res = await client.session().get(appUrl, { timeout: 5_000 });
    expect(res.status).toBe(200);
    expect(res.diagnostics.remoteAddr).toBe(`127.0.0.1:${port}`);
    expect(dns.queries).toContainEqual({ name: app, type: 1 });
  });

  it("fails a name the server does not know", async () => {
    const dns = await dnsServer();
    const unknown = `unknown.${TEST_DOMAIN}`;
    const error = await testClient({ dns: { server: dns.address } })
      .session()
      .get(`https://${unknown}:${port}/get`, { timeout: 5_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(dns.queries.some(({ name }) => name === unknown)).toBe(true);
  });

  it("applies the family to the addresses it returns", async () => {
    const dns = await dnsServer();
    const client = testClient({ dns: { server: dns.address }, family: 6 });
    const error = await client
      .session()
      .get(appUrl, { timeout: 5_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toMatch(/family setting/);
  });

  it("gives up on a server that never answers, after timeouts.dns", async () => {
    const silent = createSocket("udp4");
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
    try {
      const client = testClient({
        dns: { server: `127.0.0.1:${silent.address().port}` },
        timeouts: { dns: 300 },
      });
      const started = Date.now();
      const error = await client
        .session()
        .get(appUrl)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as TimeoutError).phase).toBe("dns_resolution");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      silent.close();
    }
  });
});

describe("dns resolver in JavaScript", () => {
  const name = `custom.${TEST_DOMAIN}`;
  const url = `https://${name}:${port}/get`;
  const h3Port = Number(new URL(server.h3Url).port);

  it("resolves names through the function, whether it is async or not", async () => {
    const asked: Array<[string, number]> = [];
    const sync = testClient({
      dns: {
        resolve: (host, requestedPort) => {
          asked.push([host, requestedPort]);
          return ["127.0.0.1"];
        },
      },
    });
    const res = await sync.session().get(url);
    expect([res.status, res.diagnostics.remoteAddr]).toEqual([200, `127.0.0.1:${port}`]);
    expect(asked).toContainEqual([name, port]);
    const async = testClient({ dns: { resolve: async () => ["127.0.0.1"] } });
    expect((await async.session().get(url)).status).toBe(200);
  });

  it("calls the functions as methods of the object", async () => {
    const resolver = {
      table: { [name]: ["127.0.0.1"] } as Record<string, string[]>,
      resolve(host: string): string[] {
        return this.table[host] ?? [];
      },
    };
    expect((await testClient({ dns: resolver }).session().get(url)).status).toBe(200);
  });

  it("lets an address that carries a port override the request's", async () => {
    const dns = { resolve: () => [`127.0.0.1:${port}`] };
    const res = await testClient({ dns }).session().get(`https://${name}:1/get`);
    expect([res.status, res.diagnostics.remoteAddr]).toEqual([200, `127.0.0.1:${port}`]);
  });

  it("applies the family to the addresses it returns", async () => {
    const dns = { resolve: () => ["::1", "127.0.0.1"] };
    const res = await testClient({ dns, family: 4 }).session().get(url);
    expect(res.diagnostics.remoteAddr).toBe(`127.0.0.1:${port}`);
    const only4 = { resolve: () => ["127.0.0.1"] };
    const error = await testClient({ dns: only4, family: 6 })
      .session()
      .get(url)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toMatch(/family setting/);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("boom");
      },
      /boom/,
    ],
    ["rejects", () => Promise.reject(new Error("refused")), /refused/],
    ["returns no address", () => [], /no addresses/],
    ["returns a name", () => ["localhost"], /not an IP address/],
    ["returns port 0", () => ["127.0.0.1:0"], /non-zero port/],
    ["returns a bracketed IPv6 without a port", () => ["[::1]"], /not an IP address/],
    ["returns no array", () => "127.0.0.1" as unknown as string[], /array of addresses/],
  ])("fails the connection when the function %s", async (_, resolve, message) => {
    const error = await testClient({ dns: { resolve } })
      .session()
      .get(url, { timeout: 5_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toMatch(message);
  });

  it("gives up on a function that never answers, after timeouts.dns", async () => {
    const dns = { resolve: () => new Promise<string[]>(() => {}) };
    const started = Date.now();
    const error = await testClient({ dns, timeouts: { dns: 200 } })
      .session()
      .get(url)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).phase).toBe("dns_resolution");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("looks HTTPS records up for HTTP/3 and follows the answer", async () => {
    const asked: string[] = [];
    const lookupHttps = (host: string) => {
      asked.push(host);
      return { alpn: ["h3"] };
    };
    const dns = { resolve: () => ["127.0.0.1"], lookupHttps };
    const client = testClient({ preset: "chrome_155", dns });
    const h3 = await client.session().get(`https://${name}:${h3Port}/get`, { timeout: 5_000 });
    expect([h3.status, h3.httpVersion]).toEqual([200, "3.0"]);
    expect(asked).toContain(name);
    // No record, or no function to ask: the same server answers over TCP.
    const none = { resolve: () => ["127.0.0.1"], lookupHttps: async () => null };
    for (const resolver of [none, { resolve: none.resolve }]) {
      const tcp = testClient({ preset: "chrome_155", dns: resolver });
      const res = await tcp.session().get(`https://${name}:${h3Port}/get`, { timeout: 5_000 });
      expect(res.httpVersion).toBe("2.0");
    }
  });

  it("ignores an HTTPS record that makes no sense, or a failing lookup", async () => {
    const invalid = { resolve: () => ["127.0.0.1"], lookupHttps: () => ({ noDefaultAlpn: true }) };
    const failing = {
      resolve: () => ["127.0.0.1"],
      lookupHttps: () => {
        throw new Error("no records today");
      },
    };
    for (const dns of [invalid, failing]) {
      const client = testClient({ preset: "chrome_155", dns });
      const res = await client.session().get(`https://${name}:${h3Port}/get`, { timeout: 5_000 });
      expect(res.httpVersion).toBe("2.0");
    }
  });

  it("resolves a proxy's address, but not the target a proxy resolves itself", async () => {
    const proxy = await startConnectProxy();
    try {
      const asked: string[] = [];
      const dns = {
        resolve: (host: string) => {
          asked.push(host);
          return ["127.0.0.1"];
        },
      };
      const proxyUrl = `http://proxy.${TEST_DOMAIN}:${proxy.port}`;
      const session = testClient({ dns }).session({ proxy: proxyUrl });
      expect((await session.get(`https://localhost:${port}/get`)).status).toBe(200);
      expect(asked).toEqual([`proxy.${TEST_DOMAIN}`]);
    } finally {
      await proxy.close();
    }
  });

  it("is exclusive with the other forms of the dns option and the cache", () => {
    const dns = { resolve: () => ["127.0.0.1"] };
    expectInvalidConfig(() => new Client({ dns, dnsCache: { ttl: 30_000 } }));
    expectInvalidConfig(() => new Client({ dns: { resolve: "x" } as unknown as typeof dns }));
    expectInvalidConfig(
      () => new Client({ dns: { lookupHttps: () => null } as unknown as typeof dns }),
    );
  });
});

describe("family", () => {
  it.each([undefined, 0, 4] as const)("connects over IPv4 with family %s", async (family) => {
    const client = testClient(family === undefined ? {} : { family });
    const res = await client.session().get(serverUrl("/get"));
    expect(res.diagnostics.remoteAddr).toBe(`127.0.0.1:${port}`);
  });

  it("rejects a family other than 0, 4 or 6", () => {
    expectInvalidConfig(() => new Client({ family: 5 as 4 }));
  });

  it("names the setting when it excludes every address", async () => {
    const error = await testClient({ family: 6 })
      .session()
      .get(serverUrl("/get"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toMatch(/IPv6 policy/);
    expect((error as Error).message).toMatch(/family setting/);
  });

  it("refuses IPv4-mapped IPv6 addresses under family 6", async () => {
    const url = `https://[::ffff:127.0.0.1]:${port}/get`;
    await expect(testClient({ family: 6 }).session().get(url)).rejects.toThrow(/IPv6 policy/);
  });

  it.runIf(dualStackLocalhost)("picks the IPv4 address of a dual-stack name", async () => {
    const url = `https://localhost:${port}/get`;
    const res = await testClient({ family: 4 }).session().get(url);
    expect(res.diagnostics.remoteAddr).toBe(`127.0.0.1:${port}`);
  });

  it.runIf(dualStackLocalhost)("picks the IPv6 address of a dual-stack name", async () => {
    // The server listens on 127.0.0.1 only, so only the family filter explains the failure.
    const url = `https://localhost:${port}/get`;
    await expect(testClient({ family: 6 }).session().get(url)).rejects.toThrow(RequestError);
    expect((await testClient({ family: 0 }).session().get(url)).status).toBe(200);
  });
});

describe("connectTo", () => {
  // `connect-to.test` resolves nowhere, so a request to it succeeds only through the mapping.
  // The certificate does not name it, hence `rejectUnauthorized: false`.
  const origin = `connect-to.test:${port}`;
  const url = `https://${origin}/get`;
  const tls = { rejectUnauthorized: false };

  it("dials the mapped address under the original name", async () => {
    await expect(new Client({ tls }).session().get(url, { timeout: 5_000 })).rejects.toThrow(
      RequestError,
    );
    const client = new Client({ tls, connectTo: { [origin]: `127.0.0.1:${port}` } });
    const res = await client.session().get(url, { timeout: 5_000 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { headers: Record<string, string> }).headers.Host).toBe(origin);
    expect(res.diagnostics.remoteAddr).toBe(`127.0.0.1:${port}`);
  });

  it("accepts pairs and normalizes the host like URL does", async () => {
    const client = new Client({
      tls,
      connectTo: [[`CONNECT-TO.test:${port}`, `127.0.0.1:${port}`]],
    });
    expect((await client.session().get(url, { timeout: 5_000 })).status).toBe(200);
  });

  it("leaves other origins alone", async () => {
    const client = testClient({ connectTo: { [`127.0.0.1:${port + 1}`]: "192.0.2.1:9" } });
    expect((await client.session().get(serverUrl("/get"))).status).toBe(200);
  });

  it.each([
    [{ "example.com": "192.0.2.1:443" }, /has no port/],
    [{ "example.com:0": "192.0.2.1:443" }, /invalid port/],
    [{ "example.com:65536": "192.0.2.1:443" }, /invalid port/],
    [{ "::1:443": "192.0.2.1:443" }, /unbracketed IPv6 host/],
    [{ "exa mple.com:443": "192.0.2.1:443" }, /invalid host/],
    [{ "a/b:443": "192.0.2.1:443" }, /invalid host/],
    [{ "example.com:443": "192.0.2.1" }, /must be "ip:port"/],
    [{ "example.com:443": "192.0.2.1:0" }, /non-zero port/],
    [{ "Example.com:443": "192.0.2.1:443", "example.com:443": "192.0.2.2:443" }, /more than once/],
  ])("rejects %j", (connectTo, message) => {
    expectInvalidConfig(() => new Client({ connectTo }));
    expect(() => new Client({ connectTo })).toThrow(message);
  });

  it.each([
    [4, "[2001:db8::1]:443"],
    [6, "192.0.2.1:443"],
    [6, "[::ffff:192.0.2.1]:443"],
  ] as const)("refuses an address family %s excludes: %s", (family, address) => {
    expect(() => new Client({ family, connectTo: { "example.com:443": address } })).toThrow(
      `family ${family} excludes`,
    );
  });
});
