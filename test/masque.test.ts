import { beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  type ClientOptions,
  ProxyConfig,
  ProxyError,
  ProxyPool,
  RequestError,
} from "../src/index.js";
import { h3Url, server, serverUrl, testClient } from "./support/clients.js";
import { expectInvalidConfig } from "./support/helpers.js";

// The end-to-end tests run a real tunnel: the client dials the MASQUE test proxy over HTTP/3,
// which relays the inner QUIC connection to the HTTP/3 test server as plain UDP. What the
// proxy recorded, read from the main server, tells a request that went through the tunnel
// from one that did not.

interface ConnectRecord {
  target: [string, number] | null;
  headers: Record<string, string>;
  status: number;
}

interface ProxyStats {
  connects: ConnectRecord[];
  datagrams_to_target: number;
  datagrams_to_client: number;
}

const control = testClient().session();
const h3Port = Number(new URL(server.h3Url).port);
const TIMEOUT = 10_000;

/** What the MASQUE proxy has seen since the last reset. */
async function proxyStats(): Promise<ProxyStats> {
  return (await control.get(serverUrl("/_test/masque/stats"))).json<ProxyStats>();
}

/** Clears the proxy's record and optionally makes it demand a header. */
async function resetProxy(requiredHeader?: [string, string]): Promise<void> {
  await control.post(serverUrl("/_test/masque/reset"), {
    json: requiredHeader ? { required_header: requiredHeader } : {},
  });
}

/** A client trusting the proxy's certificate (and, through the test CA, the origin's). */
function masqueClient(options: ClientOptions = {}): Client {
  return testClient({ quicProfile: "chrome_153", masque: { ca: server.ca }, ...options });
}

describe("MASQUE configuration", () => {
  it("rejects a trust bundle without a usable certificate", () => {
    for (const ca of [
      "",
      "not a certificate",
      "-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n",
    ]) {
      expectInvalidConfig(() => new Client({ masque: { ca } }));
    }
    expect(() => new Client({ masque: { ca: [server.ca, server.ca] } })).not.toThrow();
  });

  it("validates the tunnel limits", () => {
    expectInvalidConfig(() => new Client({ masque: { tunnelIdleTimeout: -1 } }));
    expect(
      () => new Client({ masque: { tunnelIdleTimeout: null, maxIdleTunnels: 0 } }),
    ).not.toThrow();
  });

  it("parses masque:// with the default port and refuses it as a chain hop", () => {
    const proxy = ProxyConfig.parse("masque://proxy.example");
    expect(proxy.toString()).toBe("masque://proxy.example:443");
    expect(proxy.hopCount).toBe(1);
    expectInvalidConfig(() =>
      ProxyConfig.chain(["masque://proxy.example:443", "http://final.example:8080"]),
    );
  });

  it("requires masque for a health check tunnel probe", () => {
    expectInvalidConfig(
      () => new ProxyPool([server.masqueUrl], { healthCheck: { tunnelProbe: true } }),
    );
    expect(
      () =>
        new ProxyPool([server.masqueUrl], {
          healthCheck: { tunnelProbe: true, masque: {}, interval: 60_000 },
        }),
    ).not.toThrow();
  });
});

describe("requests through a MASQUE proxy", () => {
  beforeEach(async () => {
    await resetProxy();
  });

  it("carries an HTTP/3 request through the tunnel", async () => {
    const session = masqueClient().session({
      proxy: server.masqueUrl,
      preferredHttpVersion: "http3_only",
    });
    const res = await session.get(h3Url("/get"), { timeout: TIMEOUT });
    expect([res.status, res.httpVersion]).toEqual([200, "3.0"]);
    const stats = await proxyStats();
    expect(stats.connects).toHaveLength(1);
    expect(stats.connects[0]?.target).toEqual(["127.0.0.1", h3Port]);
    expect(stats.connects[0]?.headers[":protocol"]).toBe("connect-udp");
    expect(stats.datagrams_to_target).toBeGreaterThan(0);
    expect(stats.datagrams_to_client).toBeGreaterThan(0);
  });

  it("reaches HTTP/3 through the tunnel under the default protocol policy", async () => {
    const session = masqueClient().session({ proxy: server.masqueUrl });
    for (let i = 0; i < 2; i++) {
      const res = await session.get(h3Url("/get"), { timeout: TIMEOUT });
      expect([res.status, res.httpVersion]).toEqual([200, "3.0"]);
    }
    expect((await proxyStats()).datagrams_to_client).toBeGreaterThan(0);
  });

  it("streams a response through the tunnel", async () => {
    const session = masqueClient().session({ proxy: server.masqueUrl });
    const res = await session.stream(h3Url("/get"), { timeout: TIMEOUT });
    await expect(res.json()).resolves.toHaveProperty("headers");
    const stats = await proxyStats();
    expect(stats.connects[0]?.target).toEqual(["127.0.0.1", h3Port]);
  });

  it("fails an HTTP/2 request instead of going direct", async () => {
    const session = masqueClient().session({
      proxy: server.masqueUrl,
      preferredHttpVersion: "http2_only",
    });
    await expect(session.get(serverUrl("/get"), { timeout: TIMEOUT })).rejects.toBeInstanceOf(
      ProxyError,
    );
    expect((await proxyStats()).connects).toEqual([]);
  });

  it("does not let the client's rejectUnauthorized reach the outer hop", async () => {
    const client = new Client({
      quicProfile: "chrome_153",
      tls: { rejectUnauthorized: false },
      masque: {},
    });
    await expect(
      client
        .session({ proxy: server.masqueUrl, preferredHttpVersion: "http3_only" })
        .get(h3Url("/get"), { timeout: TIMEOUT }),
    ).rejects.toBeInstanceOf(RequestError);
    expect((await proxyStats()).connects).toEqual([]);
  });

  it("skips the proxy certificate check with masque.rejectUnauthorized false", async () => {
    const client = new Client({
      quicProfile: "chrome_153",
      tls: { rejectUnauthorized: false },
      masque: { useNativeCerts: false, rejectUnauthorized: false },
    });
    const res = await client
      .session({ proxy: server.masqueUrl, preferredHttpVersion: "http3_only" })
      .get(h3Url("/get"), { timeout: TIMEOUT });
    expect(res.status).toBe(200);
  });

  it("sends an HTTP credential in the header it was told to", async () => {
    await resetProxy(["authorization", "Bearer token-123"]);
    const proxy = ProxyConfig.parse(server.masqueUrl)
      .withHttpAuth("Bearer", "token-123")
      .withAuthHeader("authorization");
    const res = await masqueClient()
      .session({ proxy, preferredHttpVersion: "http3_only" })
      .get(h3Url("/get"), { timeout: TIMEOUT });
    expect(res.status).toBe(200);
    const { connects } = await proxyStats();
    expect(connects.length).toBeGreaterThan(0);
    for (const connect of connects) {
      expect(connect.status).toBe(200);
      expect(connect.headers).not.toHaveProperty("proxy-authorization");
    }
  });

  it("fails with ProxyError when the proxy rejects the credential", async () => {
    await resetProxy(["proxy-authorization", "Bearer right"]);
    const proxy = ProxyConfig.parse(server.masqueUrl).withHttpAuth("Bearer", "wrong");
    await expect(
      masqueClient()
        .session({ proxy, preferredHttpVersion: "http3_only" })
        .get(h3Url("/get"), { timeout: TIMEOUT }),
    ).rejects.toBeInstanceOf(ProxyError);
    const { connects } = await proxyStats();
    expect(connects.map((connect) => connect.status)).toEqual([407]);
  });

  it("probes a MASQUE proxy with a real tunnel during health checks", async () => {
    const pool = new ProxyPool([server.masqueUrl], {
      healthCheck: {
        interval: 60_000,
        timeout: 5_000,
        targetHost: "127.0.0.1",
        targetPort: h3Port,
        tunnelProbe: true,
        masque: { ca: server.ca },
      },
    });
    // The first check runs as soon as the pool is built.
    let stats = await proxyStats();
    for (let i = 0; i < 200 && stats.connects.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stats = await proxyStats();
    }
    expect(pool).toBeInstanceOf(ProxyPool);
    expect(stats.connects).toHaveLength(1);
    expect(stats.connects[0]).toMatchObject({ target: ["127.0.0.1", h3Port], status: 200 });
  });
});
