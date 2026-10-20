import type { NativeDiagnostics, NativeRedirect, NativeResponse } from "../native/index.cjs";
import { HttpStatusError } from "./errors.js";
import { bodyUnusable, parseJson, toArrayBuffer } from "./internal/body-reader.js";
import { decodeText } from "./internal/charset.js";
import { headersFromFlat, unflatten } from "./internal/pairs.js";
import type { Diagnostics, HttpVersion, RedirectRecord } from "./types.js";

/**
 * A buffered HTTP response, shaped like the Fetch standard's `Response`.
 *
 * The body is read at most once, by any of `text()`, `json()`, `bytes()`, `arrayBuffer()`,
 * `blob()` or `body`; reading it again throws a `TypeError`, as in `fetch`. `bytes()` returns
 * the received memory itself, without a copy.
 */
export class Response {
  /** HTTP status code. */
  readonly status: number;
  /** Standard reason phrase of the status (the one on the wire is not kept). */
  readonly statusText: string;
  /** Final URL, after redirects. */
  readonly url: string;
  /** Response headers. */
  readonly headers: Headers;
  /**
   * Response headers as name/value pairs, keeping duplicates such as several `set-cookie`.
   * Names are lower-case.
   */
  readonly headerList: ReadonlyArray<readonly [string, string]>;
  /** HTTP version the response arrived over. */
  readonly httpVersion: HttpVersion;
  /** Redirects followed before this response, oldest first. */
  readonly history: readonly RedirectRecord[];
  /** Phase timings and transport details. */
  readonly diagnostics: Diagnostics;
  /** Wall-clock time of the whole exchange, in milliseconds. */
  readonly elapsed: number;
  #body: Buffer | undefined;
  #stream: ReadableStream<Uint8Array> | null | undefined;

  /** Responses come from a `Session`; they cannot be constructed directly. */
  private constructor(native: NativeResponse) {
    this.status = native.status;
    this.statusText = native.statusText;
    this.url = native.url;
    this.headers = headersFromFlat(native.headers);
    this.headerList = unflatten(native.headers);
    this.httpVersion = native.httpVersion as HttpVersion;
    this.history = native.history.map(toRedirectRecord);
    this.diagnostics = toDiagnostics(native.diagnostics);
    this.elapsed = native.elapsed;
    this.#body = native.body;
  }

  /** @internal Wraps a response produced by the native layer. */
  static fromNative(native: NativeResponse): Response {
    return new Response(native);
  }

  /** Whether the status is in the 200–299 range. */
  get ok(): boolean {
    return this.status >= 200 && this.status <= 299;
  }

  /** Whether at least one redirect was followed. */
  get redirected(): boolean {
    return this.history.length > 0;
  }

  /** Whether the body has been read. */
  get bodyUsed(): boolean {
    return this.#body === undefined;
  }

  /** Cookies the response set, by name (later `Set-Cookie` headers win). */
  get cookies(): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const header of this.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();
      if (name !== "") {
        cookies[name] = separator === -1 ? "" : pair.slice(separator + 1).trim();
      }
    }
    return cookies;
  }

  /** The body as a stream, or `null` when it is empty. Reading it consumes the body. */
  get body(): ReadableStream<Uint8Array> | null {
    if (this.#stream === undefined) {
      this.#stream =
        this.#body === undefined || this.#body.length === 0
          ? null
          : // A default (not byte) stream: enqueueing into a byte stream would transfer, and
            // so detach, the zero-copy buffer.
            new ReadableStream<Uint8Array>({
              pull: (controller) => {
                controller.enqueue(this.#take());
                controller.close();
              },
            });
    }
    return this.#stream;
  }

  /**
   * The body as text. Without `encoding`, a byte order mark wins, then the `charset` of
   * `Content-Type`, then UTF-8; an unknown declared charset also falls back to UTF-8.
   * `encoding` is a WHATWG encoding label (for example `"gbk"`) that overrides both; an
   * unknown label throws `RangeError`.
   */
  async text(options: { readonly encoding?: string } = {}): Promise<string> {
    return decodeText(this.#take(), this.headers.get("content-type"), options.encoding);
  }

  /** The body parsed as JSON; throws `JsonDecodeError` (a `SyntaxError`) when it is not. */
  async json<T = unknown>(): Promise<T> {
    return parseJson<T>(await this.text());
  }

  /** The body bytes, as the zero-copy `Buffer` received from the network. */
  async bytes(): Promise<Uint8Array> {
    return this.#take();
  }

  /** The body as an `ArrayBuffer`, copied only when the bytes do not fill one exactly. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return toArrayBuffer(this.#take());
  }

  /** The body as a `Blob` typed with the response's `Content-Type`. */
  async blob(): Promise<Blob> {
    return new Blob([this.#take()], { type: this.headers.get("content-type") ?? "" });
  }

  /** Throws `HttpStatusError` when the status is 400 or higher; returns the response otherwise. */
  throwForStatus(): this {
    if (this.status >= 400) {
      // Same wording as upstream's own status error.
      const message = `HTTP status error ${this.status} for url (${this.url})`;
      throw new HttpStatusError(message, this.status, { kind: "status", url: this.url });
    }
    return this;
  }

  /** Hands out the body once and marks it used. */
  #take(): Buffer {
    const body = this.#body;
    if (body === undefined) {
      throw bodyUnusable();
    }
    this.#body = undefined;
    return body;
  }
}

/** Converts one native redirect hop. */
function toRedirectRecord(native: NativeRedirect): RedirectRecord {
  return {
    url: native.url,
    status: native.status,
    headers: headersFromFlat(native.headers),
    location: native.location,
  };
}

/** Converts native diagnostics, leaving out phases that did not run. */
function toDiagnostics(native: NativeDiagnostics): Diagnostics {
  const diagnostics: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(native)) {
    if (value !== null && value !== undefined) {
      diagnostics[key] = value as number | string;
    }
  }
  return diagnostics as Diagnostics;
}
