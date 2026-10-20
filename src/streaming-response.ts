import type { NativeError, NativeStreamingResponse } from "../native/index.cjs";
import { AbortError, type RequestError } from "./errors.js";
import type { AbortLink } from "./internal/abort.js";
import { bodyUnusable, parseJson, toArrayBuffer } from "./internal/body-reader.js";
import { decodeText } from "./internal/charset.js";
import { fromNativeError } from "./internal/native-error.js";
import { headersFromFlat, unflatten } from "./internal/pairs.js";

/**
 * A response whose body is read from the network as it is consumed, from `session.stream()`.
 *
 * The body methods match `Response`, but `body` is a real stream: each chunk is pulled when
 * the consumer asks for it, so a slow consumer slows the download down instead of buffering
 * it. Chunks arrive decompressed unless the request set `decompress: false`.
 *
 * Upstream's streaming responses carry no URL, HTTP version, redirect history or
 * diagnostics, so unlike `Response` this has none of those.
 *
 * @example
 * ```ts
 * const res = await session.stream("https://example.com/big.bin");
 * for await (const chunk of res.body) {
 *   file.write(chunk);
 * }
 * ```
 */
export class StreamingResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Standard reason phrase of the status. */
  readonly statusText: string;
  /** Response headers. */
  readonly headers: Headers;
  /** Response headers as name/value pairs, keeping duplicates. Names are lower-case. */
  readonly headerList: ReadonlyArray<readonly [string, string]>;
  /** The body, pulled from the network chunk by chunk. */
  readonly body: ReadableStream<Uint8Array>;
  readonly #native: NativeStreamingResponse;
  readonly #url: string;
  readonly #abort: AbortLink;
  #disturbed = false;
  #finished = false;

  /** Streaming responses come from `Session#stream()`. */
  private constructor(nativeResponse: NativeStreamingResponse, url: string, abort: AbortLink) {
    this.#native = nativeResponse;
    this.#url = url;
    this.#abort = abort;
    this.status = nativeResponse.status;
    this.statusText = nativeResponse.statusText;
    const headers = nativeResponse.headers;
    this.headers = headersFromFlat(headers);
    this.headerList = unflatten(headers);
    // An abort releases the connection even when nobody is reading.
    abort.onAbort(() => nativeResponse.cancel());
    // `highWaterMark: 0` keeps the stream from reading ahead before the consumer asks. A
    // default (not byte) stream, so the zero-copy chunks are not transferred and detached.
    this.body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => this.#pull(controller),
        cancel: () => {
          // A cancelled body counts as used, as in fetch.
          this.#disturbed = true;
          this.#finish(true);
        },
      },
      { highWaterMark: 0 },
    );
  }

  /** @internal Wraps a response produced by the native layer; it takes `abort` over. */
  static fromNative(
    nativeResponse: NativeStreamingResponse,
    url: string,
    abort: AbortLink,
  ): StreamingResponse {
    return new StreamingResponse(nativeResponse, url, abort);
  }

  /** Whether the status is in the 200–299 range. */
  get ok(): boolean {
    return this.status >= 200 && this.status <= 299;
  }

  /** Whether reading the body has started. */
  get bodyUsed(): boolean {
    return this.#disturbed;
  }

  /** The rest of the body as text, decoded like `Response#text()`. */
  async text(options: { readonly encoding?: string } = {}): Promise<string> {
    return decodeText(await this.#readAll(), this.headers.get("content-type"), options.encoding);
  }

  /** The rest of the body parsed as JSON; throws `JsonDecodeError` when it is not. */
  async json<T = unknown>(): Promise<T> {
    return parseJson<T>(await this.text());
  }

  /** The rest of the body as bytes; a single chunk is returned without a copy. */
  async bytes(): Promise<Uint8Array> {
    return this.#readAll();
  }

  /** The rest of the body as an `ArrayBuffer`. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return toArrayBuffer(await this.#readAll());
  }

  /** The rest of the body as a `Blob` typed with the response's `Content-Type`. */
  async blob(): Promise<Blob> {
    return new Blob([await this.#readAll()], { type: this.headers.get("content-type") ?? "" });
  }

  /** Releases the connection without reading the rest of the body, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.body.locked) {
      await this.body.cancel();
    } else {
      this.#finish(true);
    }
  }

  /** Reads one chunk into the stream, or ends it. */
  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.#disturbed = true;
    const chunk = await this.#native.read(this.#abort.handle);
    if (chunk.data) {
      controller.enqueue(chunk.data);
      return;
    }
    this.#finish(false);
    if (this.#abort.aborted) {
      controller.error(new AbortError(undefined, { cause: this.#abort.reason, url: this.#url }));
    } else if (chunk.error) {
      controller.error(this.#error(chunk.error));
    } else {
      controller.close();
    }
  }

  /** Reads everything that is left. */
  async #readAll(): Promise<Buffer> {
    if (this.#disturbed || this.body.locked) {
      throw bodyUnusable();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of this.body) {
      chunks.push(chunk as Buffer);
    }
    return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
  }

  /** Stops listening for aborts and, when `cancel` is set, releases the native body. */
  #finish(cancel: boolean): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#abort.release();
    if (cancel) {
      this.#native.cancel();
    }
  }

  /** The public error for a failed read. */
  #error(error: NativeError): RequestError {
    // Reading a body fails only with request errors; options were validated long before.
    return fromNativeError(error, { url: this.#url }) as RequestError;
  }
}
