import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RequestError } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";

/** What `/upload-echo` reports about the body it received. */
interface UploadEcho {
  length: number;
  sha256: string;
  content_type: string | null;
  content_length: string | null;
  transfer_encoding: string | null;
  http_version: string;
}

/** What httpbin's `/post` reports. */
interface PostEcho {
  data: string;
  form: Record<string, string>;
  files: Record<string, string>;
  json: unknown;
  headers: Record<string, string>;
}

const session = testClient().session();
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** POSTs `body` to `/upload-echo` and returns what the server received. */
async function echo(options: Parameters<typeof session.post>[1]): Promise<UploadEcho> {
  const res = await session.post(serverUrl("/upload-echo"), options);
  return res.json<UploadEcho>();
}

describe("request bodies", () => {
  it("sends json as application/json", async () => {
    const res = await session.post(serverUrl("/post"), { json: { a: 1, b: [true, null] } });
    const body = await res.json<PostEcho>();
    expect(body.json).toEqual({ a: 1, b: [true, null] });
    expect(body.headers["Content-Type"]).toBe("application/json");
  });

  it("sends a string as UTF-8 text/plain", async () => {
    const res = await session.post(serverUrl("/post"), { body: "héllo" });
    const body = await res.json<PostEcho>();
    expect(body.data).toBe("héllo");
    expect(body.headers["Content-Type"]).toBe("text/plain;charset=UTF-8");
  });

  it("sends URLSearchParams as a urlencoded form", async () => {
    const res = await session.post(serverUrl("/post"), {
      body: new URLSearchParams({ a: "1", b: "x y" }),
    });
    const body = await res.json<PostEcho>();
    expect(body.form).toEqual({ a: "1", b: "x y" });
    expect(body.headers["Content-Type"]).toBe("application/x-www-form-urlencoded;charset=UTF-8");
  });

  it.each([
    ["Uint8Array", (bytes: Uint8Array) => bytes],
    ["ArrayBuffer", (bytes: Uint8Array) => bytes.slice().buffer],
    ["DataView", (bytes: Uint8Array) => new DataView(bytes.buffer, 1, bytes.length - 2)],
  ])("sends a %s without a content type", async (_, wrap) => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const body = wrap(bytes);
    const expected = body instanceof DataView ? bytes.subarray(1, -1) : bytes;
    await expect(echo({ body })).resolves.toMatchObject({
      length: expected.length,
      sha256: sha256(expected),
      content_type: null,
    });
  });

  it("sends a Blob with its type", async () => {
    const blob = new Blob(["<p>hi</p>"], { type: "text/html" });
    await expect(echo({ body: blob })).resolves.toMatchObject({
      length: 9,
      content_type: "text/html",
    });
  });

  it("keeps an explicit Content-Type", async () => {
    const received = await echo({ body: "a=1", headers: { "Content-Type": "text/x-custom" } });
    expect(received.content_type).toBe("text/x-custom");
  });

  it("sends FormData as multipart with a Chrome-style boundary", async () => {
    const form = new FormData();
    form.append("field", "value");
    form.append("upload", new Blob(["file content"], { type: "text/plain" }), "a.txt");
    const res = await session.post(serverUrl("/post"), { body: form });
    const body = await res.json<PostEcho>();
    expect(body.form).toEqual({ field: "value" });
    expect(body.files).toEqual({ upload: "file content" });
    expect(body.headers["Content-Type"]).toMatch(
      /^multipart\/form-data; boundary=----WebKitFormBoundary/,
    );
  });

  it("rejects json combined with body, and contentLength without a stream", async () => {
    await expect(session.post(serverUrl("/post"), { json: {}, body: "x" })).rejects.toThrow(
      TypeError,
    );
    await expect(session.post(serverUrl("/post"), { body: "x", contentLength: 1 })).rejects.toThrow(
      TypeError,
    );
    await expect(
      session.post(serverUrl("/post"), { body: 42 as unknown as string }),
    ).rejects.toThrow(TypeError);
  });
});

describe("streamed request bodies", () => {
  const chunks = Array.from({ length: 64 }, (_, i) => new Uint8Array(16 * 1024).fill(i));
  const all = Buffer.concat(chunks);

  /** An async generator over the test chunks. */
  async function* generate(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  it.each([
    ["an async generator", () => generate()],
    ["a Node.js Readable", () => Readable.from(chunks)],
    ["a web ReadableStream", () => ReadableStream.from(chunks)],
  ])("streams %s", async (_, source) => {
    await expect(echo({ body: source() })).resolves.toMatchObject({
      length: all.length,
      sha256: sha256(all),
    });
  });

  it("uses chunked framing on HTTP/1.1 when the length is unknown", async () => {
    const h1 = testClient().session({ preferredHttpVersion: "http1_only" });
    const res = await h1.post(serverUrl("/upload-echo"), { body: generate() });
    await expect(res.json<UploadEcho>()).resolves.toMatchObject({
      sha256: sha256(all),
      transfer_encoding: "chunked",
      http_version: "1.1",
    });
  });

  it("encodes string chunks as UTF-8", async () => {
    const text = Readable.from(["héllo ", "wörld"]);
    const expected = Buffer.from("héllo wörld");
    await expect(echo({ body: text })).resolves.toMatchObject({
      length: expected.length,
      sha256: sha256(expected),
    });
  });

  it("sends the declared contentLength", async () => {
    const received = await echo({ body: generate(), contentLength: all.length });
    expect(received).toMatchObject({ length: all.length, content_length: String(all.length) });
  });

  it("fails when the source does not match the declared length", async () => {
    const error = await session
      .post(serverUrl("/upload-echo"), { body: generate(), contentLength: all.length + 1 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RequestError);
  });

  it("fails with the source's error as the cause", async () => {
    const failure = new Error("source broke");
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(1024);
      throw failure;
    }
    const error = await session
      .post(serverUrl("/upload-echo"), { body: broken() })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).cause).toBe(failure);
  });

  it("rejects chunks that are neither bytes nor strings", async () => {
    async function* numbers(): AsyncGenerator<number> {
      yield 1;
    }
    const error = await session
      .post(serverUrl("/upload-echo"), { body: numbers() as unknown as AsyncIterable<Uint8Array> })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).cause).toBeInstanceOf(TypeError);
  });
});
