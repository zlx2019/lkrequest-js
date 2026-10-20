import { describe, expect, it } from "vitest";
import {
  Client,
  ConnectionError,
  pendingRequests,
  RequestError,
  Response,
  TimeoutError,
  TlsError,
} from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { closedPort } from "./support/helpers.js";
import { rawResponse, startRawHttpServer } from "./support/raw-http.js";

describe("requests", () => {
  it("resolves with a fetch-style response", async () => {
    const res = await testClient().session().get(serverUrl("/get?a=1"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.statusText).toBe("OK");
    expect(res.url).toBe(serverUrl("/get?a=1"));
    expect(res.redirected).toBe(false);
    expect(res.httpVersion).toBe("2.0");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headerList).toContainEqual(["content-type", "application/json"]);
    expect(res.diagnostics.protocol).toBe("h2");
    expect(res.elapsed).toBeGreaterThan(0);
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toMatchObject({ args: { a: "1" } });
    expect(res.bodyUsed).toBe(true);
  });

  it("runs requests concurrently on one session", async () => {
    const session = testClient().session();
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => session.get(serverUrl(`/get?i=${i}`))),
    );
    const bodies = await Promise.all(responses.map((res) => res.json<{ args: { i: string } }>()));
    expect(bodies.map((body) => Number(body.args.i))).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
  });

  it("reports a refused connection as a ConnectionError", async () => {
    const url = `https://127.0.0.1:${await closedPort()}/`;
    const error = await testClient()
      .session()
      .get(url)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: "ERR_LK_CONNECTION", phase: "tcp_connect", url });
    expect(typeof (error as RequestError).retryable).toBe("boolean");
  });

  it("reports an untrusted certificate as a TlsError", async () => {
    const error = await new Client()
      .session()
      .get(serverUrl("/get"))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TlsError);
    expect(error).toMatchObject({ code: "ERR_LK_TLS", phase: "tls_handshake", kind: "tls" });
  });

  it("releases every request from the pending count", async () => {
    await testClient().session().get(serverUrl("/get"));
    expect(pendingRequests()).toBe(0);
  });
});

/** The JSON httpbin echoes back for `/anything`, `/get` and friends. */
interface Echo {
  method: string;
  url: string;
  args: Record<string, string>;
  headers: Record<string, string>;
}

describe("request options", () => {
  const session = testClient().session();

  it.each([
    ["a record", { a: "1", b: "x y" }],
    [
      "pairs",
      [
        ["a", "1"],
        ["b", "x y"],
      ] as const,
    ],
    ["URLSearchParams", new URLSearchParams({ a: "1", b: "x y" })],
    ["a query string", "a=1&b=x+y"],
  ])("appends params given as %s", async (_, params) => {
    const res = await session.get(serverUrl("/get"), { params });
    await expect(res.json<Echo>()).resolves.toMatchObject({ args: { a: "1", b: "x y" } });
  });

  it("sends headers given as pairs, a record or a Headers object", async () => {
    for (const headers of [
      [
        ["x-one", "1"],
        ["x-two", "2"],
      ] as const,
      { "x-one": "1", "x-two": "2" },
      new Headers({ "x-one": "1", "x-two": "2" }),
    ]) {
      const res = await session.get(serverUrl("/headers"), { headers });
      const echo = await res.json<Echo>();
      expect(echo.headers).toMatchObject({ "X-One": "1", "X-Two": "2" });
    }
  });

  it("sends each value of a name repeated among pairs, buffered or streamed", async () => {
    const raw = await startRawHttpServer(() => rawResponse("200 OK"));
    try {
      const headers = [
        ["x-multi", "1"],
        ["x-other", "2"],
        ["X-Multi", "3"],
      ] as const;
      await session.get(raw.url, { headers });
      await (await session.stream(raw.url, { headers })).text();
      expect(raw.requests).toHaveLength(2);
      for (const request of raw.requests) {
        // A name goes out where it first appeared, all its values together.
        expect(request.fields.filter(([name]) => name.startsWith("x-"))).toEqual([
          ["x-multi", "1"],
          ["x-multi", "3"],
          ["x-other", "2"],
        ]);
      }
    } finally {
      await raw.close();
    }
  });

  it("replaces every default of the name, where repeated defaults keep their last", async () => {
    const client = testClient({
      defaultHeaders: [
        ["x-default", "1"],
        ["x-default", "2"],
        ["x-multi", "default"],
      ],
    });
    const res = await client.session().get(serverUrl("/headers"), {
      headers: [
        ["x-multi", "1"],
        ["x-multi", "3"],
      ],
    });
    expect(res.httpVersion).toBe("2.0");
    // httpbin joins repeated fields with commas.
    const { headers } = await res.json<Echo>();
    expect(headers).toMatchObject({ "X-Default": "2", "X-Multi": "1,3" });
  });

  it("sends bearer and basic credentials", async () => {
    const bearer = await session.get(serverUrl("/bearer"), { auth: { bearer: "token" } });
    expect(bearer.status).toBe(200);
    // Test passwords stay under 4 characters: the public-release sanitizer rewrites longer ones.
    const basic = await session.get(serverUrl("/basic-auth/user/pwd"), {
      auth: { username: "user", password: "pwd" },
    });
    expect(basic.status).toBe(200);
    const wrong = await session.get(serverUrl("/basic-auth/user/pwd"), {
      auth: { username: "user", password: "bad" },
    });
    expect(wrong.status).toBe(401);
  });

  it("sends request cookies, and cookieOverride replaces the session's", async () => {
    const own = testClient().session();
    await own.get(serverUrl("/cookies/set?jar=session"));
    const res = await own.get(serverUrl("/cookies"), {
      cookies: { extra: "1" },
      cookieOverride: { jar: "override" },
    });
    await expect(res.json()).resolves.toEqual({ cookies: { extra: "1", jar: "override" } });
  });

  it("fails with TimeoutError when the request outlives its timeout", async () => {
    const error = await session
      .get(serverUrl("/delay/3"), { timeout: 300 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ code: "ERR_LK_TIMEOUT" });
  });

  it("keeps the body compressed with decompress: false", async () => {
    const res = await session.get(serverUrl("/gzip"), { decompress: false });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const bytes = await res.bytes();
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it("decompresses by default", async () => {
    const res = await session.get(serverUrl("/gzip"));
    await expect(res.json()).resolves.toMatchObject({ gzipped: true });
  });

  it("advertises the requested content codings", async () => {
    const res = await session.get(serverUrl("/headers"), { acceptEncoding: ["gzip", "br"] });
    const echo = await res.json<Echo>();
    expect(echo.headers["Accept-Encoding"]).toBe("gzip, br");
  });

  // ASGI upper-cases every method it reports, so the casing the client sent cannot be
  // observed here; these check that standard and custom methods both get through.
  it.each([
    ["post", "POST"],
    ["PURGE", "PURGE"],
  ])("sends method %s", async (method, sent) => {
    const res = await session.request(serverUrl("/upload-echo"), { method });
    await expect(res.json()).resolves.toMatchObject({ method: sent });
  });

  it("resolves relative URLs against the session's baseUrl", async () => {
    const based = testClient().session({ baseUrl: serverUrl("/anything/") });
    const res = await based.get("nested?x=1");
    expect(res.url).toBe(serverUrl("/anything/nested?x=1"));
  });

  it("rejects an invalid method with ERR_LK_INVALID_CONFIG", async () => {
    await expect(
      session.request(serverUrl("/get"), { method: "BAD METHOD" }),
    ).rejects.toMatchObject({ name: "TypeError", code: "ERR_LK_INVALID_CONFIG" });
  });
});
