import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { afterEach, describe, expect, it } from "vitest";
import {
  AbortError,
  ConnectionError,
  type Middleware,
  type RequestEndMessage,
  type RequestErrorMessage,
  type RequestStartMessage,
} from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { closedPort } from "./support/helpers.js";

/** One message with the channel it came on. */
type Seen =
  | { channel: "start"; message: RequestStartMessage }
  | { channel: "end"; message: RequestEndMessage }
  | { channel: "error"; message: RequestErrorMessage };

const names = {
  start: "lkrequest:request:start",
  end: "lkrequest:request:end",
  error: "lkrequest:request:error",
} as const;

const subscriptions: Array<[string, (message: unknown) => void]> = [];

afterEach(() => {
  for (const [name, listener] of subscriptions.splice(0)) {
    unsubscribe(name, listener);
  }
});

/** The message at `index`, typed by the channel the test expects it on. */
function at<T extends Seen["message"]>(seen: Seen[], index: number): T {
  const item = seen[index];
  if (item === undefined) throw new Error(`no message #${index}`);
  return item.message as T;
}

/** Subscribes to the three request channels; the returned list fills in publishing order. */
function watch(): Seen[] {
  const seen: Seen[] = [];
  for (const channel of ["start", "end", "error"] as const) {
    const listener = (message: unknown): void => {
      seen.push({ channel, message } as Seen);
    };
    subscribe(names[channel], listener);
    subscriptions.push([names[channel], listener]);
  }
  return seen;
}

describe("diagnostics channels", () => {
  it("publishes start and end around a request, sharing the request object", async () => {
    const seen = watch();
    const res = await testClient()
      .session()
      .get(serverUrl("/get"), { params: { q: "1 2" }, headers: { "x-trace": "abc" } });
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "end"]);
    const { request } = at<RequestStartMessage>(seen, 0);
    const end = at<RequestEndMessage>(seen, 1);
    expect(end.request).toBe(request);
    expect(request.method).toBe("GET");
    expect(request.url).toBe(serverUrl("/get?q=1+2"));
    expect(request.headers).toContainEqual(["x-trace", "abc"]);
    const { response } = end;
    expect(response).toMatchObject({
      status: 200,
      statusText: "OK",
      url: res.url,
      httpVersion: "2.0",
    });
    expect(response.headers).toContainEqual(["content-type", "application/json"]);
    expect(response.elapsed).toBeGreaterThan(0);
  });

  it("describes the request after middleware, and the response before it", async () => {
    const seen = watch();
    const middleware: Middleware = {
      onRequest: (request) => {
        request.headers.push(["x-added", "yes"]);
        request.url = serverUrl("/status/201");
      },
      onResponse: (response) => {
        response.status = 299;
      },
    };
    const res = await testClient({ middleware: [middleware] })
      .session()
      .get(serverUrl("/get"));
    expect(res.status).toBe(299);
    expect(at<RequestStartMessage>(seen, 0).request).toMatchObject({
      url: serverUrl("/status/201"),
      headers: expect.arrayContaining([["x-added", "yes"]]),
    });
    // The server's answer, not what the middleware turned it into.
    expect(at<RequestEndMessage>(seen, 1).response.status).toBe(201);
  });

  it("publishes once for a request that follows redirects, with the final URL", async () => {
    const seen = watch();
    await testClient()
      .session()
      .get(serverUrl(`/redirect-to?url=${encodeURIComponent(serverUrl("/get"))}`));
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "end"]);
    expect(at<RequestEndMessage>(seen, 1).response.url).toBe(serverUrl("/get"));
  });

  it("publishes an error instead of an end when the request fails", async () => {
    const seen = watch();
    const port = await closedPort();
    const error = await testClient()
      .session()
      .get(`https://127.0.0.1:${port}/`, { timeout: 5_000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "error"]);
    const failed = at<RequestErrorMessage>(seen, 1);
    expect(failed.request).toBe(at<RequestStartMessage>(seen, 0).request);
    expect(failed.error).toBe(error);
  });

  it("publishes an error for a request that is aborted", async () => {
    const seen = watch();
    const controller = new AbortController();
    const pending = testClient()
      .session()
      .get(serverUrl("/delay/5"), { signal: controller.signal })
      .catch((caught: unknown) => caught);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toBeInstanceOf(AbortError);
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "error"]);
    expect(at<RequestErrorMessage>(seen, 1).error).toBeInstanceOf(AbortError);
  });

  it("publishes an end for an HTTP error status, which is a response, not a failure", async () => {
    const seen = watch();
    await testClient().session().get(serverUrl("/status/503"));
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "end"]);
    expect(at<RequestEndMessage>(seen, 1).response.status).toBe(503);
  });

  it("publishes for streamed requests when the headers arrive, before the body is read", async () => {
    const seen = watch();
    const res = await testClient().session().stream(serverUrl("/stream-bytes/2000?seed=1"));
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "end"]);
    const { response } = at<RequestEndMessage>(seen, 1);
    expect(response).toMatchObject({ status: 200, statusText: "OK" });
    expect(response.url).toBeUndefined();
    expect((await res.bytes()).byteLength).toBe(2000);
    const port = await closedPort();
    await testClient()
      .session()
      .stream(`https://127.0.0.1:${port}/`, { timeout: 5_000 })
      .catch(() => undefined);
    expect(seen.map(({ channel }) => channel)).toEqual(["start", "end", "start", "error"]);
  });

  it("publishes for the client's own methods and for every method shortcut", async () => {
    const seen = watch();
    await testClient().get(serverUrl("/get"));
    await testClient().post(serverUrl("/post"), { json: { a: 1 } });
    const session = testClient().session();
    await session.put(serverUrl("/put"));
    expect(seen.map(({ channel }) => channel)).toEqual([
      "start",
      "end",
      "start",
      "end",
      "start",
      "end",
    ]);
    const methods = seen
      .filter(({ channel }) => channel === "start")
      .map(({ message }) => (message as RequestStartMessage).request.method);
    expect(methods).toEqual(["GET", "POST", "PUT"]);
  });

  it("keeps the messages of concurrent requests apart", async () => {
    const seen = watch();
    const session = testClient().session();
    await Promise.all(
      [1, 2, 3].map((n) => session.get(serverUrl("/get"), { params: { n: String(n) } })),
    );
    const starts = seen.filter(({ channel }) => channel === "start");
    const ends = seen.filter(({ channel }) => channel === "end");
    expect(starts).toHaveLength(3);
    for (const start of starts) {
      const request = (start.message as RequestStartMessage).request;
      const matching = ends.filter(
        ({ message }) => (message as RequestEndMessage).request === request,
      );
      expect(matching).toHaveLength(1);
    }
  });

  it("publishes nothing for a request that cannot start, such as on a closed session", async () => {
    const seen = watch();
    const session = testClient().session();
    session.close();
    await expect(session.get(serverUrl("/get"))).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("costs nothing without subscribers", async () => {
    const res = await testClient().session().get(serverUrl("/get"));
    expect(res.status).toBe(200);
  });

  it("publishes the end of a request for subscribers of that channel only", async () => {
    const ends: RequestEndMessage[] = [];
    const listener = (message: unknown): void => {
      ends.push(message as RequestEndMessage);
    };
    subscribe(names.end, listener);
    subscriptions.push([names.end, listener]);
    await testClient().session().get(serverUrl("/get"));
    expect(ends).toHaveLength(1);
    expect(ends[0]?.request.url).toBe(serverUrl("/get"));
  });
});
