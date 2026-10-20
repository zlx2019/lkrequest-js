import type { RequestEvent, RequestHook, ResponseEvent, ResponseHook } from "../hooks.js";
import type { Middleware, MiddlewareRequest, MiddlewareResponse } from "../middleware.js";
import { native } from "./native.js";

/** Runs the `onRequest` interceptors in order. */
export async function runRequestMiddleware(
  chain: readonly Middleware[],
  request: MiddlewareRequest,
): Promise<MiddlewareRequest> {
  let current = request;
  for (const middleware of chain) {
    if (middleware.onRequest) {
      current = (await middleware.onRequest(current)) ?? current;
    }
  }
  return current;
}

/** Runs the `onResponse` interceptors in reverse order. */
export async function runResponseMiddleware(
  chain: readonly Middleware[],
  response: MiddlewareResponse,
): Promise<MiddlewareResponse> {
  let current = response;
  for (const middleware of chain.toReversed()) {
    if (middleware.onResponse) {
      current = (await middleware.onResponse(current)) ?? current;
    }
  }
  return current;
}

/** The event hooks of one session. */
export class Hooks {
  readonly #request = new Set<RequestHook>();
  readonly #response = new Set<ResponseHook>();

  /** Registers a request hook; returns the function that removes it. */
  addRequestHook(hook: RequestHook): () => void {
    this.#request.add(hook);
    return () => this.#request.delete(hook);
  }

  /** Registers a response hook; returns the function that removes it. */
  addResponseHook(hook: ResponseHook): () => void {
    this.#response.add(hook);
    return () => this.#response.delete(hook);
  }

  /** Notifies the request hooks. */
  fireRequest(event: RequestEvent): void {
    for (const hook of this.#request) {
      notify("onRequest", () => hook(event));
    }
  }

  /** Notifies the response hooks. */
  fireResponse(event: ResponseEvent): void {
    for (const hook of this.#response) {
      notify("onResponse", () => hook(event));
    }
  }
}

/** Calls a hook without letting it fail the request; failures are logged as warnings. */
function notify(name: string, call: () => void | Promise<void>): void {
  const warn = (error: unknown): void =>
    native.logFacadeWarning(
      `${name} hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  try {
    // Not awaited: hooks observe the request and must not hold it up.
    Promise.resolve(call()).catch(warn);
  } catch (error) {
    warn(error);
  }
}
