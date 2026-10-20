import { describe, expect, it } from "vitest";
import { h3Url, server, serverUrl, testClient } from "./support/clients.js";

const h3Port = Number(new URL(server.h3Url).port);

describe("HTTP/3", () => {
  it("serves a request over QUIC with http3_only", async () => {
    const session = testClient({ preset: "chrome_155" }).session({
      preferredHttpVersion: "http3_only",
    });
    const res = await session.get(h3Url("/get"), { timeout: 5_000 });
    expect(res.status).toBe(200);
    expect(res.httpVersion).toBe("3.0");
    expect(res.diagnostics.protocol).toBe("h3");
    await expect(res.json()).resolves.toHaveProperty("headers");
  });

  it.each(["chrome", "chrome_146", "chrome_153", "chrome_154", "chrome_155"])(
    "keeps the connection across responses that use the QPACK dynamic table (%s)",
    async (quicProfile) => {
      // The Chrome presets advertise a 64 KiB dynamic table and aioquic uses it from the
      // second response on; decoding static references only used to kill the connection.
      const session = testClient({ quicProfile }).session({ preferredHttpVersion: "http3_only" });
      for (let i = 0; i < 4; i++) {
        const res = await session.get(h3Url("/get"), { timeout: 5_000 });
        expect([res.status, res.httpVersion]).toEqual([200, "3.0"]);
      }
    },
  );

  it("decodes concurrent responses against one dynamic table", async () => {
    const session = testClient({ quicProfile: "chrome_154" }).session({
      preferredHttpVersion: "http3_only",
    });
    await session.get(h3Url("/get"), { timeout: 5_000 });
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => session.get(h3Url(`/get?n=${i}`), { timeout: 10_000 })),
    );
    expect(responses.map((res) => [res.status, res.httpVersion])).toEqual(
      Array.from({ length: 30 }, () => [200, "3.0"]),
    );
  });

  it("streams a response over HTTP/3", async () => {
    const session = testClient({ quicProfile: "chrome_155" }).session({
      preferredHttpVersion: "http3_only",
    });
    const res = await session.stream(h3Url("/stream-bytes/50000?seed=3"), { timeout: 5_000 });
    expect((await res.bytes()).byteLength).toBe(50_000);
  });

  it.runIf(server.h3UrlIpv6 !== null).each([0, 6] as const)(
    "reaches an IPv6 target with family %s",
    async (family) => {
      const session = testClient({ quicProfile: "chrome_154", family }).session({
        preferredHttpVersion: "http3_only",
      });
      const res = await session.get(new URL("/get", server.h3UrlIpv6 ?? "").href, {
        timeout: 5_000,
      });
      expect([res.status, res.httpVersion]).toEqual([200, "3.0"]);
    },
  );

  it("dials the connectTo address over QUIC", async () => {
    const client = testClient({
      quicProfile: "chrome_154",
      tls: { rejectUnauthorized: false },
      connectTo: { [`connect-to.test:${h3Port}`]: `127.0.0.1:${h3Port}` },
    });
    const res = await client
      .session({ preferredHttpVersion: "http3_only" })
      .get(`https://connect-to.test:${h3Port}/get`, { timeout: 5_000 });
    expect([res.status, res.httpVersion]).toEqual([200, "3.0"]);
  });

  it("reuses the pooled HTTP/2 connection when HTTP/3 falls back", async () => {
    // The main server is TCP only, so every HTTP/3 attempt falls back. Upstream once looked
    // only for a pooled HTTP/3 connection and redialled TCP and TLS for each request.
    const session = testClient({ preset: "chrome_152" }).session({
      preferredHttpVersion: "http3_with_fallback",
    });
    const first = await session.get(serverUrl("/get"));
    expect(first.httpVersion).toBe("2.0");
    expect(first.diagnostics.tlsMs).toBeDefined();
    for (let i = 0; i < 2; i++) {
      const res = await session.get(serverUrl("/get"));
      expect(res.httpVersion).toBe("2.0");
      expect(res.diagnostics.tcpMs).toBeUndefined();
      expect(res.diagnostics.tlsMs).toBeUndefined();
    }
  });

  it("never tries HTTP/3 with disableHttp3", async () => {
    const session = testClient({ quicProfile: "chrome_155", disableHttp3: true }).session();
    const res = await session.get(h3Url("/get"), { timeout: 5_000 });
    expect(res.httpVersion).toBe("2.0");
  });
});
