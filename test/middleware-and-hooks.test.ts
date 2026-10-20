import { describe, expect, it } from "vitest";
import {
  type Middleware,
  RequestError,
  type RequestEvent,
  type ResponseEvent,
} from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { closedPort } from "./support/helpers.js";

/** What httpbin's `/anything` reports. */
interface Echo {
  method: string;
  url: string;
  data: string;
  headers: Record<string, string>;
}

/** A middleware that records the order its interceptors ran in. */
function recorder(name: string, log: string[]): Middleware {
  return {
    name,
    onRequest: () => {
      log.push(`${name}:request`);
      return undefined;
    },
    onResponse: () => {
      log.push(`${name}:response`);
      return undefined;
    },
  };
}

describe("request middleware", () => {
  it("adds headers the server receives", async () => {
    const inject: Middleware = {
      onRequest: (request) => {
        request.headers.push(["x-injected", "yes"]);
        return request;
      },
    };
    const res = await testClient({ middleware: [inject] })
      .session()
      .get(serverUrl("/anything"));
    expect((await res.json<Echo>()).headers["X-Injected"]).toBe("yes");
  });

  it("changes the method and URL", async () => {
    const reroute: Middleware = {
      onRequest: (request) => ({ ...request, method: "PUT", url: serverUrl("/anything/moved") }),
    };
    const res = await testClient()
      .session({ middleware: [reroute] })
      .get(serverUrl("/get"));
    const echo = await res.json<Echo>();
    expect(echo.method).toBe("PUT");
    expect(echo.url).toBe(serverUrl("/anything/moved"));
  });

  it("sees a buffered body and may replace it", async () => {
    let seen: string | undefined;
    const rewrite: Middleware = {
      onRequest: (request) => {
        seen = new TextDecoder().decode(request.body);
        request.body = new TextEncoder().encode("replaced");
        return undefined;
      },
    };
    const res = await testClient()
      .session({ middleware: [rewrite] })
      .post(serverUrl("/anything"), { body: "original" });
    expect(seen).toBe("original");
    expect((await res.json<Echo>()).data).toBe("replaced");
  });

  it("sees no body for a streamed upload, and bytes replace the stream", async () => {
    let seen: Uint8Array | undefined = new Uint8Array(1);
    const rewrite: Middleware = {
      onRequest: (request) => {
        seen = request.body;
        request.body = new TextEncoder().encode("instead");
        return request;
      },
    };
    async function* source(): AsyncGenerator<string> {
      yield "streamed";
    }
    const res = await testClient()
      .session({ middleware: [rewrite] })
      .post(serverUrl("/anything"), { body: source() });
    expect(seen).toBeUndefined();
    expect((await res.json<Echo>()).data).toBe("instead");
  });

  it("fails the request with the error a middleware throws", async () => {
    const failure = new Error("blocked by policy");
    const block: Middleware = {
      onRequest: () => {
        throw failure;
      },
    };
    await expect(
      testClient()
        .session({ middleware: [block] })
        .get(serverUrl("/get")),
    ).rejects.toBe(failure);
  });

  it("may be async", async () => {
    const slow: Middleware = {
      onRequest: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        request.headers.push(["x-async", "1"]);
        return request;
      },
    };
    const res = await testClient()
      .session({ middleware: [slow] })
      .get(serverUrl("/anything"));
    expect((await res.json<Echo>()).headers["X-Async"]).toBe("1");
  });
});

describe("response middleware", () => {
  it("changes the status, headers and body the caller sees", async () => {
    const rewrite: Middleware = {
      onResponse: (response) => ({
        status: 418,
        headers: [...response.headers, ["x-rewritten", "1"]],
        body: new TextEncoder().encode('{"rewritten":true}'),
      }),
    };
    const res = await testClient()
      .session({ middleware: [rewrite] })
      .get(serverUrl("/get"));
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("I'm a Teapot");
    expect(res.headers.get("x-rewritten")).toBe("1");
    await expect(res.json()).resolves.toEqual({ rewritten: true });
  });

  it("runs only for responses, not for failed requests", async () => {
    let called = false;
    const watch: Middleware = {
      onResponse: () => {
        called = true;
        return undefined;
      },
    };
    const url = `https://127.0.0.1:${await closedPort()}/`;
    await expect(
      testClient()
        .session({ middleware: [watch] })
        .get(url),
    ).rejects.toThrow(RequestError);
    expect(called).toBe(false);
  });
});

describe("middleware order", () => {
  it("runs the client's before the session's, and responses in reverse", async () => {
    const log: string[] = [];
    const client = testClient({ middleware: [recorder("client", log)] });
    const session = client.session({
      middleware: [recorder("first", log), recorder("second", log)],
    });
    await session.get(serverUrl("/get"));
    expect(log).toEqual([
      "client:request",
      "first:request",
      "second:request",
      "second:response",
      "first:response",
      "client:response",
    ]);
  });

  it("runs once per logical request, around redirects", async () => {
    const log: string[] = [];
    await testClient()
      .session({ middleware: [recorder("only", log)] })
      .get(serverUrl("/redirect/2"));
    expect(log).toEqual(["only:request", "only:response"]);
  });

  it("runs request middleware, but not response middleware, for a stream", async () => {
    const log: string[] = [];
    const inject: Middleware = {
      ...recorder("stream", log),
      onRequest: (request) => {
        log.push("stream:request");
        request.headers.push(["x-injected", "yes"]);
        return request;
      },
    };
    const res = await testClient()
      .session({ middleware: [inject] })
      .stream(serverUrl("/anything"));
    expect((await res.json<Echo>()).headers["X-Injected"]).toBe("yes");
    expect(log).toEqual(["stream:request"]);
  });
});

describe("event hooks", () => {
  it("tells the hooks given at creation about each request and response", async () => {
    const requests: RequestEvent[] = [];
    const responses: ResponseEvent[] = [];
    const session = testClient().session({
      onRequest: (event) => {
        requests.push(event);
      },
      onResponse: (event) => {
        responses.push(event);
      },
    });
    await session.get(serverUrl("/get"), { headers: [["x-a", "1"]] });
    expect(requests).toEqual([{ method: "GET", url: serverUrl("/get"), headers: [["x-a", "1"]] }]);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ status: 200, url: serverUrl("/get") });
    expect(responses[0]?.elapsed).toBeGreaterThan(0);
  });

  it("adds and removes hooks after creation", async () => {
    const session = testClient().session();
    const methods: string[] = [];
    const statuses: number[] = [];
    const stopRequests = session.onRequest(({ method }) => {
      methods.push(method);
    });
    const stopResponses = session.onResponse(({ status }) => {
      statuses.push(status);
    });
    await session.post(serverUrl("/post"));
    stopRequests();
    stopResponses();
    await session.get(serverUrl("/get"));
    expect(methods).toEqual(["POST"]);
    expect(statuses).toEqual([200]);
  });

  it("does not let a failing hook affect the request", async () => {
    const session = testClient().session({
      onRequest: () => {
        throw new Error("sync failure");
      },
      onResponse: async () => {
        throw new Error("async failure");
      },
    });
    expect((await session.get(serverUrl("/get"))).status).toBe(200);
  });

  it("does not call onResponse for a failed request", async () => {
    let called = false;
    const session = testClient().session({
      onResponse: () => {
        called = true;
      },
    });
    const url = `https://127.0.0.1:${await closedPort()}/`;
    await expect(session.get(url)).rejects.toThrow(RequestError);
    expect(called).toBe(false);
  });
});
