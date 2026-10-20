import { describe, expect, it } from "vitest";
import {
  AbortError,
  Hsts,
  pendingRequests,
  StreamingResponse,
  TimeoutError,
} from "../src/index.js";
import { server, serverUrl, testClient } from "./support/clients.js";
import { collectGarbage, waitFor } from "./support/helpers.js";

const session = testClient().session();

/** What httpbin's `/post` reports. */
interface PostEcho {
  form: Record<string, string>;
  json: unknown;
  headers: Record<string, string>;
}

describe("session.stream", () => {
  it("resolves with the status and headers before the body is read", async () => {
    const res = await session.stream(serverUrl("/get"));
    expect(res).toBeInstanceOf(StreamingResponse);
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headerList).toContainEqual(["content-type", "application/json"]);
    expect(res.bodyUsed).toBe(false);
    const body = await res.json<{ url: string }>();
    expect(body.url).toBe(serverUrl("/get"));
    expect(res.bodyUsed).toBe(true);
  });

  it("yields the body chunk by chunk from body", async () => {
    // httpbin caps /stream-bytes at 100 KiB.
    const size = 100 * 1024;
    const res = await session.stream(serverUrl(`/stream-bytes/${size}?chunk_size=4096&seed=7`));
    let received = 0;
    let chunks = 0;
    for await (const chunk of res.body) {
      expect(chunk).toBeInstanceOf(Uint8Array);
      received += chunk.byteLength;
      chunks += 1;
    }
    expect(received).toBe(size);
    expect(chunks).toBeGreaterThan(1);
  });

  it("reads the rest with text, bytes, arrayBuffer and blob", async () => {
    await expect((await session.stream(serverUrl("/html"))).text()).resolves.toContain(
      "<!DOCTYPE html>",
    );
    const bytes = await (await session.stream(serverUrl("/bytes/1000?seed=1"))).bytes();
    expect(bytes.byteLength).toBe(1000);
    const buffer = await (await session.stream(serverUrl("/bytes/10?seed=1"))).arrayBuffer();
    expect(buffer.byteLength).toBe(10);
    const blob = await (await session.stream(serverUrl("/image/png"))).blob();
    expect(blob.type).toBe("image/png");
  });

  it("refuses to read the body twice", async () => {
    const res = await session.stream(serverUrl("/get"));
    await res.text();
    await expect(res.text()).rejects.toThrow("Body is unusable");
  });

  it("decompresses unless decompress is false", async () => {
    const decoded = await session.stream(serverUrl("/gzip"));
    await expect(decoded.json()).resolves.toMatchObject({ gzipped: true });
    const raw = await session.stream(serverUrl("/gzip"), { decompress: false });
    const bytes = await raw.bytes();
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it("sends request bodies and credentials", async () => {
    const res = await session.stream(serverUrl("/post"), {
      method: "POST",
      body: new URLSearchParams({ k: "v" }),
      auth: { bearer: "tok123" },
    });
    const echo = await res.json<PostEcho>();
    expect(echo.form).toEqual({ k: "v" });
    expect(echo.headers.Authorization).toBe("Bearer tok123");
  });

  it("returns a redirect as is instead of following it", async () => {
    const res = await session.stream(serverUrl("/redirect/1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/get");
    await res.body.cancel();
  });

  it("applies the session's HSTS upgrade", async () => {
    // A hostname, because HSTS never applies to an IP literal.
    const port = new URL(server.url).port;
    const hsts = testClient().session({ hsts: Hsts.static(["localhost"]) });
    const res = await hsts.stream(`http://localhost:${port}/get`);
    await expect(res.json<{ url: string }>()).resolves.toMatchObject({
      url: `https://localhost:${port}/get`,
    });
  });

  it("does not read ahead: an unread body holds nothing in flight", async () => {
    const res = await session.stream(serverUrl("/drip?duration=1&numbytes=4&delay=0"));
    expect(pendingRequests()).toBe(0);
    await res.body.cancel();
  });

  it("fails the body with the request's error", async () => {
    const res = await testClient({ limits: { maxResponseBodySize: 1024 } })
      .session()
      .stream(serverUrl("/bytes/4096"));
    await expect(res.bytes()).rejects.toMatchObject({ code: "ERR_LK_RESOURCE_LIMIT" });
  });

  it("times out like a buffered request", async () => {
    await expect(session.stream(serverUrl("/delay/5"), { timeout: 500 })).rejects.toThrow(
      TimeoutError,
    );
  });
});

describe("aborting a stream", () => {
  it("aborts while waiting for the headers", async () => {
    const controller = new AbortController();
    const pending = session.stream(serverUrl("/delay/5"), { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 100);
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    await waitFor(() => pendingRequests() === 0);
  });

  it("aborts while reading the body, with the signal's reason as the cause", async () => {
    const controller = new AbortController();
    const reason = new Error("enough");
    const res = await session.stream(serverUrl("/drip?duration=5&numbytes=5&delay=0"), {
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort(reason);
    const error = await reader.read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AbortError);
    expect((error as AbortError).cause).toBe(reason);
    await waitFor(() => pendingRequests() === 0);
  });

  it("releases the connection when the body is cancelled", async () => {
    const res = await session.stream(serverUrl("/drip?duration=5&numbytes=5&delay=0"));
    const reader = res.body.getReader();
    const pending = reader.read();
    await reader.cancel();
    await expect(pending).resolves.toMatchObject({ done: true });
    await waitFor(() => pendingRequests() === 0);
  });

  it("releases the connection when an unread response is garbage collected", async () => {
    // Over HTTP/1.1 an unread body keeps its connection checked out of the pool.
    const h1 = testClient().session({ preferredHttpVersion: "http1_only" });
    await (async () => {
      const res = await h1.stream(serverUrl("/drip?duration=5&numbytes=5&delay=0"));
      expect(res.status).toBe(200);
      expect(h1.poolStats().total).toBe(1);
    })();
    await collectGarbage();
    await waitFor(() => h1.poolStats().total === 0);
  });

  it("releases the connection on Symbol.asyncDispose", async () => {
    const res = await session.stream(serverUrl("/drip?duration=5&numbytes=5&delay=0"));
    await res[Symbol.asyncDispose]();
    expect(res.bodyUsed).toBe(true);
    await expect(res.text()).rejects.toThrow(TypeError);
    await waitFor(() => pendingRequests() === 0);
  });
});
