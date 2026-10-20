import { describe, expect, it } from "vitest";
import { Client, ConnectionError, listPresets } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { closedPort, expectInvalidConfig } from "./support/helpers.js";

describe("Client", () => {
  it("works without any option", async () => {
    const res = await testClient().session().get(serverUrl("/get"));
    expect(res.status).toBe(200);
  });

  it.each(listPresets().map((preset) => preset.name))(
    "completes a request with the %s preset",
    async (preset) => {
      const res = await testClient({ preset }).session().get(serverUrl("/get"));
      expect(res.status).toBe(200);
    },
  );

  it("rejects an unknown preset", () => {
    expectInvalidConfig(() => new Client({ preset: "chrome_1" }));
  });

  it("rejects invalid durations and counts", () => {
    expectInvalidConfig(() => new Client({ timeouts: { total: -1 } }));
    expectInvalidConfig(() => new Client({ timeouts: { dns: Number.NaN } }));
    expectInvalidConfig(() => new Client({ limits: { maxHeaderCount: 1.5 } }));
    expectInvalidConfig(() => new Client({ h2: { dispatchBatchSize: 0 } }));
    expectInvalidConfig(() => new Client({ limits: { maxPendingH2Requests: 0 } }));
  });

  it("accepts every timeout, limit and fallback option", () => {
    expect(
      () =>
        new Client({
          timeouts: {
            dns: 1_000,
            tcpConnect: 1_000,
            tlsHandshake: 1_000,
            ttfb: 1_000,
            total: 5_000,
          },
          limits: {
            maxResponseBodySize: 1 << 20,
            maxConnectionsPerSession: 4,
            maxPendingH2Requests: 8,
            maxHeaderCount: 64,
            maxHeaderSize: 8_192,
            maxHeadersTotalSize: 65_536,
            minTransferRate: { bytesPerSecond: 1, window: 1_000 },
          },
          h2: { dispatchBatchSize: 2 },
          fallback: { h2ToH1: true, retryOnConnectionClose: true },
        }),
    ).not.toThrow();
  });

  it("sends its default headers with every request", async () => {
    const session = testClient({ defaultHeaders: { "x-default": "yes" } }).session();
    const res = await session.get(serverUrl("/headers"));
    const { headers } = await res.json<{ headers: Record<string, string> }>();
    expect(headers["X-Default"]).toBe("yes");
  });

  it("rejects invalid session options", () => {
    expectInvalidConfig(() => testClient().session({ acceptEncoding: ["gzip", "lzma" as "gzip"] }));
    expectInvalidConfig(() => testClient().session({ idleTimeout: -5 }));
  });
});

describe("Client requests", () => {
  /** What the test server's `/anything` saw of a request. */
  interface Seen {
    method: string;
    args: Record<string, string>;
    headers: Record<string, string>;
    json: unknown;
  }

  it.each(["get", "post", "put", "delete", "patch"] as const)(
    "sends a %s request with a session of its own",
    async (method) => {
      const res = await testClient()[method](serverUrl("/anything"), { params: { q: "1" } });
      expect(res.status).toBe(200);
      const seen = await res.json<Seen>();
      expect(seen.method).toBe(method.toUpperCase());
      expect(seen.args).toEqual({ q: "1" });
    },
  );

  it("sends head and options requests", async () => {
    const client = testClient();
    const head = await client.head(serverUrl("/anything"));
    expect([head.status, (await head.bytes()).byteLength]).toEqual([200, 0]);
    const options = await client.options(serverUrl("/anything"));
    expect(options.status).toBe(200);
  });

  it("takes the options of session requests, and URL objects", async () => {
    const url = new URL(serverUrl("/anything"));
    const res = await testClient().post(url, { json: { a: 1 }, headers: { "x-one": "1" } });
    const seen = await res.json<Seen>();
    expect(seen.json).toEqual({ a: 1 });
    expect(seen.headers["X-One"]).toBe("1");
    const named = await testClient().request(url, { method: "PUT" });
    expect((await named.json<Seen>()).method).toBe("PUT");
  });

  it("runs the client's middleware and default headers", async () => {
    const client = testClient({
      defaultHeaders: { "x-default": "yes" },
      middleware: [
        {
          onRequest: (request) => {
            request.headers.push(["x-middleware", "yes"]);
          },
        },
      ],
    });
    const seen = await (await client.get(serverUrl("/anything"))).json<Seen>();
    expect(seen.headers["X-Default"]).toBe("yes");
    expect(seen.headers["X-Middleware"]).toBe("yes");
  });

  it("keeps no cookies between requests", async () => {
    const client = testClient();
    // The redirect target is part of the first request's session, so it sees the cookie.
    const first = await client.get(serverUrl("/cookies/set?a=1"));
    expect((await first.json<{ cookies: Record<string, string> }>()).cookies).toEqual({ a: "1" });
    const second = await client.get(serverUrl("/cookies"));
    expect((await second.json<{ cookies: Record<string, string> }>()).cookies).toEqual({});
  });

  it("rejects a failed request with the error a session would", async () => {
    const port = await closedPort();
    await expect(testClient().get(`https://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(
      ConnectionError,
    );
    // A bad URL rejects too; the methods never throw synchronously.
    await expect(testClient().get("not a url")).rejects.toThrow(TypeError);
  });
});
