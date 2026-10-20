import { JsonDecodeError } from "../errors.js";

/** Parses JSON text, throwing `JsonDecodeError` (a `SyntaxError`) when it is not JSON. */
export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new JsonDecodeError((error as Error).message, { cause: error });
  }
}

/** The bytes as an `ArrayBuffer`, copied only when they do not fill one exactly. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer } = bytes;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return buffer;
  }
  return new Uint8Array(bytes).buffer;
}

/** The error every body method throws once the body has been consumed. */
export function bodyUnusable(): TypeError {
  return new TypeError("Body is unusable: Body has already been read");
}
