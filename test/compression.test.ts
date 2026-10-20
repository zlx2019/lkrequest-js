import { deflateRawSync, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testClient } from "./support/clients.js";
import { type RawHttpServer, rawResponse, startRawHttpServer } from "./support/raw-http.js";

// deflate bodies the httpbin server cannot send, written byte for byte by a raw server.

const text = "lkrequest reads deflate bodies in either form. ".repeat(2_000);

// A raw deflate stream (RFC 1951) whose first block is stored: 0x78 holds BFINAL 0 and BTYPE
// 00, then come LEN 156 (9c 00) and its complement (63 ff). The first two bytes, 78 9c, are
// also a valid zlib header (RFC 1950), the form RFC 9110 means by `deflate`.
const stored = "A".repeat(156);
const lookalike = Buffer.concat([
  Buffer.from([0x78, 0x9c, 0x00, 0x63, 0xff]),
  Buffer.from(stored),
  deflateRawSync(text),
]);

const zlib = deflateSync(text);
const badChecksum = Buffer.from(zlib);
const last = badChecksum.length - 1;
badChecksum.writeUInt8(badChecksum.readUInt8(last) ^ 1, last);

/** The body served at each path, with `Content-Encoding: deflate`. */
const bodies: Record<string, Buffer> = {
  "/zlib": zlib,
  "/raw": deflateRawSync(text),
  "/lookalike": lookalike,
  "/truncated": zlib.subarray(0, zlib.length >> 1),
  "/bad-checksum": badChecksum,
};

let raw: RawHttpServer;

beforeAll(async () => {
  raw = await startRawHttpServer((request) => {
    const path = request.line.split(" ")[1] ?? "";
    return rawResponse("200 OK", [["Content-Encoding", "deflate"]], bodies[path]);
  });
});

afterAll(() => raw.close());

describe("deflate bodies", () => {
  it.each([
    ["/zlib", text],
    ["/raw", text],
    ["/lookalike", stored + text],
  ])("at %s are decoded, read whole or streamed", async (path, decoded) => {
    const session = testClient().session();
    expect(await (await session.get(raw.url + path)).text()).toBe(decoded);
    expect(await (await session.stream(raw.url + path)).text()).toBe(decoded);
  });

  it.each(["/truncated", "/bad-checksum"])("at %s fail, read whole or streamed", async (path) => {
    const session = testClient().session();
    const failure = { code: "ERR_LK_REQUEST", kind: "body" };
    await expect(session.get(raw.url + path)).rejects.toMatchObject(failure);
    const streamed = await session.stream(raw.url + path);
    await expect(streamed.text()).rejects.toMatchObject(failure);
  });
});
