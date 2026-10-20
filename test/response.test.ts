import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  Client,
  HttpStatusError,
  JsonDecodeError,
  RequestError,
  TooManyRedirectsError,
} from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { rawResponse, startRawHttpServer } from "./support/raw-http.js";

const session = testClient().session();

describe("response body", () => {
  it("can be read only once, like fetch", async () => {
    const res = await session.get(serverUrl("/bytes/16"));
    expect(res.bodyUsed).toBe(false);
    await expect(res.bytes()).resolves.toHaveLength(16);
    expect(res.bodyUsed).toBe(true);
    await expect(res.text()).rejects.toThrow(/Body is unusable/);
  });

  it("returns bytes, an ArrayBuffer, a Blob and a stream", async () => {
    const bytes = await (await session.get(serverUrl("/bytes/32"))).bytes();
    expect(Buffer.isBuffer(bytes)).toBe(true);
    const buffer = await (await session.get(serverUrl("/bytes/32"))).arrayBuffer();
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBe(32);
    const blob = await (await session.get(serverUrl("/json"))).blob();
    expect(blob.type).toBe("application/json");
    const stream = (await session.get(serverUrl("/bytes/48"))).body;
    const streamed = await new globalThis.Response(stream).arrayBuffer();
    expect(streamed.byteLength).toBe(48);
  });

  it("has a null body stream when it is empty", async () => {
    const res = await session.get(serverUrl("/status/204"));
    expect(res.body).toBeNull();
    await expect(res.text()).resolves.toBe("");
  });

  it("parses JSON and reports invalid JSON as JsonDecodeError", async () => {
    await expect((await session.get(serverUrl("/json"))).json()).resolves.toHaveProperty(
      "slideshow",
    );
    const error = await (await session.get(serverUrl("/html"))).json().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(JsonDecodeError);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).not.toBeInstanceOf(RequestError);
    expect((error as JsonDecodeError).cause).toBeInstanceOf(SyntaxError);
  });
});

describe("response metadata", () => {
  it("keeps duplicate headers in headerList and exposes Set-Cookie values", async () => {
    // httpbin answers /cookies/set with a redirect carrying the Set-Cookie headers.
    const manual = await testClient()
      .session({ redirect: "manual" })
      .get(serverUrl("/cookies/set?a=1&b=2"));
    const setCookies = manual.headerList.filter(([name]) => name === "set-cookie");
    expect(setCookies).toHaveLength(2);
    expect(manual.headers.getSetCookie()).toHaveLength(2);
    expect(manual.cookies).toEqual({ a: "1", b: "2" });
  });

  it("throwForStatus throws HttpStatusError for 4xx and 5xx only", async () => {
    const ok = await session.get(serverUrl("/status/200"));
    expect(ok.throwForStatus()).toBe(ok);
    for (const status of [404, 503]) {
      const res = await session.get(serverUrl(`/status/${status}`));
      expect(res.ok).toBe(false);
      expect(() => res.throwForStatus()).toThrow(HttpStatusError);
      expect(() => res.throwForStatus()).toThrow(
        expect.objectContaining({ status, code: "ERR_LK_HTTP_STATUS" }),
      );
    }
  });

  it("consumes 103 Early Hints and returns the final response", async () => {
    const res = await session.get(serverUrl("/early-hints"));
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("final");
  });
});

describe("redirects", () => {
  it("follows redirects and records the history", async () => {
    const res = await session.get(serverUrl("/redirect/2"));
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(serverUrl("/get"));
    expect(res.history.map((hop) => hop.status)).toEqual([302, 302]);
    expect(res.history[0]?.location).toBe(serverUrl("/relative-redirect/1"));
    expect(res.history[0]?.headers.get("location")).toBeTruthy();
  });

  it("returns the redirect itself with redirect: manual", async () => {
    const res = await testClient().session({ redirect: "manual" }).get(serverUrl("/redirect/1"));
    expect(res.status).toBe(302);
    expect(res.redirected).toBe(false);
    expect(res.headers.get("location")).toBe("/get");
  });

  it("fails on the first redirect with redirect: error", async () => {
    const request = testClient().session({ redirect: "error" }).get(serverUrl("/redirect/1"));
    await expect(request).rejects.toThrow(TooManyRedirectsError);
  });

  it("fails after maxRedirects", async () => {
    const request = testClient().session({ maxRedirects: 2 }).get(serverUrl("/redirect/3"));
    await expect(request).rejects.toMatchObject({ code: "ERR_LK_TOO_MANY_REDIRECTS" });
  });

  // Reusing a pooled HTTP/1.1 connection the peer already closed can surface as hyper's bare
  // "connection error"; upstream recognizes it as a closed connection, so the redirect is sent
  // again on a new connection.
  it("redials when the server closes the HTTP/1.1 connection after a 302", async () => {
    const requestLines: string[] = [];
    const server = createServer((socket) => {
      socket.once("data", (data) => {
        requestLines.push(data.toString("latin1").split("\r\n", 1)[0] ?? "");
        socket.end(
          requestLines.length === 1
            ? "HTTP/1.1 302 Found\r\nLocation: /result\r\nContent-Length: 0\r\n\r\n"
            : "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const res = await new Client()
        .session({ preferredHttpVersion: "http1_only" })
        .post(`http://127.0.0.1:${port}/submit`, { body: "payload", timeout: 10_000 });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
      expect(requestLines[0]).toMatch(/^POST \/submit/);
      expect(requestLines[1]).toMatch(/^GET \/result/);
    } finally {
      server.close();
    }
  });

  it("follows only real redirect statuses", async () => {
    // 300 and 304 carry no redirect target to follow.
    for (const status of [300, 304]) {
      const res = await session.get(serverUrl(`/status/${status}`));
      expect(res.status).toBe(status);
      expect(res.redirected).toBe(false);
    }
  });

  it("follows a Location written in raw UTF-8, percent-encoding it", async () => {
    const raw = await startRawHttpServer((_request, index) =>
      index === 0 ? rawResponse("302 Found", [["Location", "/café"]]) : rawResponse("200 OK"),
    );
    try {
      const res = await testClient().session().get(`${raw.url}/start`);
      expect(res.status).toBe(200);
      expect(res.url).toBe(`${raw.url}/caf%C3%A9`);
      expect(raw.requests.map((request) => request.line)).toEqual([
        "GET /start HTTP/1.1",
        "GET /caf%C3%A9 HTTP/1.1",
      ]);
    } finally {
      await raw.close();
    }
  });

  it("rejects a Location that is not UTF-8", async () => {
    const latin1 = Buffer.from("/café", "latin1");
    const raw = await startRawHttpServer(() => rawResponse("302 Found", [["Location", latin1]]));
    try {
      const request = testClient().session().get(`${raw.url}/start`);
      await expect(request).rejects.toBeInstanceOf(RequestError);
      await expect(request).rejects.toMatchObject({ kind: "url_parse" });
      expect(raw.requests).toHaveLength(1);
    } finally {
      await raw.close();
    }
  });
});

/** Headers (and the method) httpbin's `/headers` or `/anything` saw on the request. */
interface Echo {
  readonly method?: string;
  readonly headers: Record<string, string>;
}

/** httpbin's `/redirect-to` on the test server, sending the request on to `target`. */
function redirectTo(target: string, status = 302): string {
  return serverUrl(
    `/redirect-to?${new URLSearchParams({ url: target, status_code: `${status}` })}`,
  );
}

/** `url` with the host name localhost: the same server, but another origin. */
function viaLocalhost(url: string): string {
  const other = new URL(url);
  other.hostname = "localhost";
  return other.href;
}

describe("the client's default headers across redirects", () => {
  // Filtered hop by hop, the way the request's own headers are.
  const defaults = {
    authorization: "Bearer t",
    cookie: "c=1",
    referer: "https://example.test/",
    "x-default": "yes",
  };

  it("keep the credentials on a redirect within the origin", async () => {
    const res = await testClient({ defaultHeaders: defaults })
      .session()
      .get(redirectTo(serverUrl("/headers")));
    const { headers } = await res.json<Echo>();
    expect(headers).toMatchObject({ Authorization: "Bearer t", Cookie: "c=1" });
  });

  it("lose the credentials, and only them, on a redirect to another origin", async () => {
    const target = viaLocalhost(serverUrl("/headers"));
    const res = await testClient({ defaultHeaders: defaults }).session().get(redirectTo(target));
    expect(res.url).toBe(target);
    const { headers } = await res.json<Echo>();
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
    expect(headers).toMatchObject({ Referer: "https://example.test/", "X-Default": "yes" });
  });

  it("stay dropped when the chain comes back to the first origin", async () => {
    const session = testClient({ defaultHeaders: defaults }).session();
    const res = await session.get(redirectTo(viaLocalhost(redirectTo(serverUrl("/headers")))));
    expect(res.history).toHaveLength(2);
    expect((await res.json<Echo>()).headers.Authorization).toBeUndefined();
    // The next request starts from the client's defaults again.
    const next = await session.get(viaLocalhost(serverUrl("/headers")));
    expect((await next.json<Echo>()).headers.Authorization).toBe("Bearer t");
  });

  it("lose a Referer on a redirect from https to http", async () => {
    const raw = await startRawHttpServer(() => rawResponse("200 OK"));
    try {
      await testClient({ defaultHeaders: defaults })
        .session()
        .get(redirectTo(`${raw.url}/`));
      const headers = raw.requests[0]?.headers;
      expect(headers).toMatchObject({ "x-default": "yes" });
      expect(headers?.referer).toBeUndefined();
      expect(headers?.authorization).toBeUndefined();
    } finally {
      await raw.close();
    }
  });

  it.each([
    [301, "GET"],
    [302, "GET"],
    [303, "GET"],
    [307, "POST"],
    [308, "POST"],
  ])("go with the body only: a POST redirected by a %i is sent as a %s", async (status, method) => {
    const res = await testClient({
      defaultHeaders: { "content-type": "application/x-test", "content-language": "en" },
    })
      .session()
      .post(redirectTo(serverUrl("/anything"), status), { body: new Uint8Array([1, 2, 3]) });
    const echo = await res.json<Echo>();
    expect(echo.method).toBe(method);
    const withBody = method === "POST";
    expect(echo.headers["Content-Type"]).toBe(withBody ? "application/x-test" : undefined);
    expect(echo.headers["Content-Language"]).toBe(withBody ? "en" : undefined);
  });
});
