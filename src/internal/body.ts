import type { NativeBody, NativePart } from "../../native/index.cjs";
import type { BodyInit, RequestOptions } from "../types.js";

/** A request body ready for the native layer. */
export interface PreparedBody {
  /** The body, or `undefined` for none. */
  readonly native: NativeBody | undefined;
  /** `Content-Type` to send when the caller set none (Fetch body-extraction rules). */
  readonly contentType: string | undefined;
  /** Error a streamed source threw, reported as the request error's `cause`. */
  sourceError(): unknown;
  /**
   * Closes a streamed source the request did not read to the end. Not awaited: an async
   * generator queues `return()` behind a pending `next()`, which would hold up the result.
   */
  close(): void;
}

const encoder = new TextEncoder();

/** A prepared body with nothing to report or release. */
function staticBody(native: NativeBody | undefined, contentType?: string): PreparedBody {
  return {
    native,
    contentType,
    sourceError: () => undefined,
    close: () => {},
  };
}

/** Normalizes `json`, `body` and `contentLength` into a native body. */
export async function prepareBody(options: RequestOptions): Promise<PreparedBody> {
  const { body, json, contentLength } = options;
  if (json !== undefined && body !== undefined) {
    throw new TypeError("json and body cannot be combined");
  }
  if (contentLength !== undefined && !isStream(body)) {
    throw new TypeError("contentLength requires a streamed body");
  }
  if (json !== undefined) {
    const text = JSON.stringify(json);
    if (text === undefined) {
      throw new TypeError("json is not serializable by JSON.stringify");
    }
    return staticBody({ bytes: encoder.encode(text) }, "application/json");
  }
  return body === undefined ? staticBody(undefined) : extract(body, contentLength);
}

/** Converts one `BodyInit` variant, in the order the Fetch standard checks them. */
async function extract(body: BodyInit, contentLength: number | undefined): Promise<PreparedBody> {
  if (typeof body === "string") {
    return staticBody({ bytes: encoder.encode(body) }, "text/plain;charset=UTF-8");
  }
  if (body instanceof URLSearchParams) {
    return staticBody(
      { bytes: encoder.encode(body.toString()) },
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
  }
  if (body instanceof FormData) {
    // No Content-Type here: upstream sets it together with its own boundary.
    return staticBody({ parts: await formParts(body) });
  }
  if (body instanceof Blob) {
    return staticBody({ bytes: new Uint8Array(await body.arrayBuffer()) }, body.type || undefined);
  }
  if (body instanceof ArrayBuffer) {
    return staticBody({ bytes: new Uint8Array(body) });
  }
  if (ArrayBuffer.isView(body)) {
    return staticBody({ bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) });
  }
  if (isStream(body)) {
    return streamBody(body, contentLength);
  }
  throw new TypeError("unsupported request body type");
}

/** `FormData` entries as native parts; files carry their name and media type. */
async function formParts(form: FormData): Promise<NativePart[]> {
  const parts: NativePart[] = [];
  for (const [name, value] of form) {
    if (typeof value === "string") {
      parts.push({ name, text: value });
    } else {
      parts.push({
        name,
        data: new Uint8Array(await value.arrayBuffer()),
        filename: value.name,
        // What Chrome sends for a file without a media type.
        contentType: value.type || "application/octet-stream",
      });
    }
  }
  return parts;
}

/** Whether a body is streamed: any async iterable, which covers both kinds of stream. */
function isStream(body: BodyInit | undefined): body is AsyncIterable<Uint8Array | string> {
  return typeof body === "object" && body !== null && Symbol.asyncIterator in body;
}

/**
 * Wraps an async iterable in the pull function the native layer calls whenever the
 * connection has room for another chunk. At most one pull is ever pending.
 */
function streamBody(
  source: AsyncIterable<Uint8Array | string>,
  contentLength: number | undefined,
): PreparedBody {
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  let failure: unknown;
  const pull = async (): Promise<Uint8Array | null> => {
    try {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        return null;
      }
      return toChunk(next.value);
    } catch (error) {
      finished = true;
      failure = error;
      throw error;
    }
  };
  return {
    native: { pull, ...(contentLength !== undefined && { length: contentLength }) },
    contentType: undefined,
    sourceError: () => failure,
    close: () => {
      if (!finished) {
        finished = true;
        // The async wrapper turns a synchronous throw from `return()` into a rejection too.
        (async () => iterator.return?.())().catch(() => {});
      }
    },
  };
}

/** One streamed chunk as bytes; strings (from `setEncoding`) are encoded as UTF-8. */
function toChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return encoder.encode(value);
  }
  throw new TypeError("a streamed body must yield Uint8Array or string chunks");
}
