import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AbortError,
  ConnectionError,
  HttpStatusError,
  JsonDecodeError,
  ProxyError,
  RequestError,
  ResourceLimitError,
  TimeoutError,
  TlsError,
  TooManyRedirectsError,
} from "../src/index.js";

describe("request error hierarchy", () => {
  const cases = [
    { ErrorClass: TlsError, name: "TlsError", code: "ERR_LK_TLS" },
    { ErrorClass: ProxyError, name: "ProxyError", code: "ERR_LK_PROXY" },
    { ErrorClass: ConnectionError, name: "ConnectionError", code: "ERR_LK_CONNECTION" },
    { ErrorClass: TimeoutError, name: "TimeoutError", code: "ERR_LK_TIMEOUT" },
    {
      ErrorClass: TooManyRedirectsError,
      name: "TooManyRedirectsError",
      code: "ERR_LK_TOO_MANY_REDIRECTS",
    },
    { ErrorClass: ResourceLimitError, name: "ResourceLimitError", code: "ERR_LK_RESOURCE_LIMIT" },
    { ErrorClass: AbortError, name: "AbortError", code: "ABORT_ERR" },
  ] as const;

  it.each(cases)("$name is a RequestError with name $name and code $code", (testCase) => {
    const err = new testCase.ErrorClass("boom");
    expect(err).toBeInstanceOf(testCase.ErrorClass);
    expect(err).toBeInstanceOf(RequestError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe(testCase.name);
    expect(err.code).toBe(testCase.code);
    expect(err.message).toBe("boom");
  });

  it("gives HttpStatusError the response status", () => {
    const err = new HttpStatusError("Not Found", 404);
    expect(err).toBeInstanceOf(RequestError);
    expect(err.code).toBe("ERR_LK_HTTP_STATUS");
    expect(err.status).toBe(404);
  });

  it("defaults the base class to ERR_LK_REQUEST and not retryable", () => {
    const err = new RequestError("failed");
    expect(err.name).toBe("RequestError");
    expect(err.code).toBe("ERR_LK_REQUEST");
    expect(err.retryable).toBe(false);
    expect(err.safeToReplay).toBe(false);
  });

  it("carries the structured details it was given", () => {
    const cause = new Error("socket hang up");
    const err = new TimeoutError("timed out", {
      cause,
      kind: "Timeout",
      phase: "ttfb",
      retryable: true,
      safeToReplay: true,
      url: "https://example.com/",
    });
    expect(err.cause).toBe(cause);
    expect(err.kind).toBe("Timeout");
    expect(err.phase).toBe("ttfb");
    expect(err.retryable).toBe(true);
    expect(err.safeToReplay).toBe(true);
    expect(err.url).toBe("https://example.com/");
  });

  it("keeps absent details off the instance so inspection output stays clean", () => {
    const err = new ConnectionError("refused");
    expect(Object.hasOwn(err, "kind")).toBe(false);
    expect(Object.hasOwn(err, "phase")).toBe(false);
    expect(Object.hasOwn(err, "url")).toBe(false);
    expect(Object.hasOwn(err, "cause")).toBe(false);
    expect(inspect(err)).toContain("ConnectionError: refused");
  });

  it("gives AbortError a default message", () => {
    expect(new AbortError().message).toBe("The operation was aborted");
  });
});

describe("JsonDecodeError", () => {
  it("is a SyntaxError, like Response#json() in the Fetch standard", () => {
    const cause = new SyntaxError("Unexpected token");
    const err = new JsonDecodeError("invalid JSON body", { cause });
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err).not.toBeInstanceOf(RequestError);
    expect(err.name).toBe("JsonDecodeError");
    expect(err.code).toBe("ERR_LK_JSON_DECODE");
    expect(err.cause).toBe(cause);
  });
});
