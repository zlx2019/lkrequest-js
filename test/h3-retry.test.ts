import { beforeEach, describe, expect, it } from "vitest";
import { type H3RetryMode, RequestError, type RequestOptions } from "../src/index.js";
import { server, serverUrl, testClient } from "./support/clients.js";
import { expectInvalidConfig } from "./support/helpers.js";

// The server behind `server.h3ClosingUrl` closes every connection with H3_INTERNAL_ERROR at its
// first request, so the connections it counted are the attempts one request took.

const control = testClient().session();

/** Connections the closing server accepted since the last reset. */
async function attempts(): Promise<number> {
  const stats = await (await control.get(serverUrl("/_test/h3-closing/stats"))).json();
  return (stats as { connections: number }).connections;
}

/** Sends one request over HTTP/3 only and returns the error it failed with. */
async function failure(mode: H3RetryMode | undefined, options: RequestOptions = {}) {
  const session = testClient({ preset: "chrome_155" }).session({
    preferredHttpVersion: "http3_only",
    ...(mode !== undefined && { h3RetryMode: mode }),
  });
  const url = `${server.h3ClosingUrl}/anything`;
  return session.request(url, { timeout: 10_000, ...options }).then(
    () => expect.unreachable("the closing server never answers"),
    (error: unknown) => error as RequestError,
  );
}

describe("h3RetryMode", () => {
  beforeEach(async () => {
    await control.post(serverUrl("/_test/h3-closing/reset"));
  });

  it.each([[undefined], ["safe"]] as const)(
    "does not retry a protocol error with %s",
    async (mode) => {
      const error = await failure(mode);
      expect(error).toBeInstanceOf(RequestError);
      expect(error.kind).toBe("connection_closed");
      expect(await attempts()).toBe(1);
    },
  );

  it("retries a protocol error twice with chrome_155_protocol_errors", async () => {
    const error = await failure("chrome_155_protocol_errors");
    // Classified by the error inside upstream's retry context, like any other failure.
    expect(error).toBeInstanceOf(RequestError);
    expect(error.kind).toBe("connection_closed");
    expect(await attempts()).toBe(3);
  });

  it("replays a POST with a buffered body, but not one marked not_idempotent", async () => {
    await failure("chrome_155_protocol_errors", { method: "POST", body: "payload" });
    expect(await attempts()).toBe(3);
    await control.post(serverUrl("/_test/h3-closing/reset"));
    await failure("chrome_155_protocol_errors", {
      method: "POST",
      body: "payload",
      idempotency: "not_idempotent",
    });
    expect(await attempts()).toBe(1);
  });

  it("refuses an unknown mode", () => {
    expectInvalidConfig(() => testClient().session({ h3RetryMode: "always" as "safe" }));
  });
});
