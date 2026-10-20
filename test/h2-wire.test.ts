import { afterEach, describe, expect, it } from "vitest";
import { AbortError, H2Profile, TimeoutError } from "../src/index.js";
import { testClient } from "./support/clients.js";
import { type H2WireServer, startH2WireServer } from "./support/h2-wire.js";
import { waitFor } from "./support/helpers.js";

// HTTP/2 as it goes on the wire, recorded by a server of the test's own (see h2-wire.ts).

/** RST_STREAM error code CANCEL (RFC 9113 §7). */
const CANCEL = 0x8;

let wire: H2WireServer;

afterEach(async () => {
  await wire?.close();
});

describe("the first stream of a connection", () => {
  it.each([
    ["chrome_155", 1],
    ["firefox_156", 3],
  ] as const)("is the one %s starts at, %i", async (preset, streamId) => {
    wire = await startH2WireServer();
    await testClient({ preset }).session().get(`${wire.url}/`);
    expect(wire.headers.map((seen) => seen.streamId)).toEqual([streamId]);
  });

  it("follows the profile's initialStreamId, the next requests two apart", async () => {
    wire = await startH2WireServer();
    const chrome = H2Profile.preset("chrome_155").toJSON();
    const h2Profile = H2Profile.fromJSON({ ...chrome, initial_stream_id: 7 });
    const session = testClient({ preset: "chrome_155", h2Profile }).session();
    await session.get(`${wire.url}/a`);
    await session.get(`${wire.url}/b`);
    expect(wire.headers.map((seen) => seen.streamId)).toEqual([7, 9]);
  });
});

describe("h2PriorityWeight", () => {
  it("sets the HEADERS weight of a request on a pooled connection, and only of it", async () => {
    wire = await startH2WireServer();
    const session = testClient({ preset: "firefox_156" }).session();
    await session.get(`${wire.url}/first`);
    await session.get(`${wire.url}/second`, { h2PriorityWeight: 21 });
    await session.get(`${wire.url}/third`);
    expect(wire.headers.map((seen) => seen.priority)).toEqual([
      { dependency: 0, exclusive: false, weight: 41 },
      { dependency: 0, exclusive: false, weight: 21 },
      { dependency: 0, exclusive: false, weight: 41 },
    ]);
  });

  it.each([0, 21, 255])(
    "sets the HEADERS weight %i of the request that opens the connection",
    async (weight) => {
      wire = await startH2WireServer();
      const session = testClient({ preset: "firefox_156" }).session();
      await session.get(`${wire.url}/first`, { h2PriorityWeight: weight });
      await session.get(`${wire.url}/second`);
      expect(wire.headers.map((seen) => seen.priority?.weight)).toEqual([weight, 41]);
    },
  );

  it("sets it on a first request that carries a body or is streamed", async () => {
    wire = await startH2WireServer();
    const client = testClient({ preset: "firefox_156" });
    await client.session().post(`${wire.url}/`, { body: "data", h2PriorityWeight: 21 });
    const streamed = await client.session().stream(`${wire.url}/`, { h2PriorityWeight: 22 });
    await streamed.text();
    expect(wire.headers.map((seen) => seen.priority?.weight)).toEqual([21, 22]);
    expect(wire.connections()).toBe(2);
  });

  it("refuses a weight outside 0 to 255", async () => {
    wire = await startH2WireServer();
    const request = testClient().session().get(`${wire.url}/`, { h2PriorityWeight: 256 });
    await expect(request).rejects.toMatchObject({ code: "ERR_LK_INVALID_CONFIG" });
    expect(wire.headers).toEqual([]);
  });
});

describe("abandoned requests", () => {
  it("reset the stream of a request aborted after it was sent", async () => {
    wire = await startH2WireServer({ answer: () => "none" });
    const controller = new AbortController();
    const request = testClient().session().get(`${wire.url}/`, { signal: controller.signal });
    await waitFor(() => wire.headers.length === 1);
    controller.abort();
    await expect(request).rejects.toBeInstanceOf(AbortError);
    await waitFor(() => wire.resets.length === 1);
    expect(wire.resets).toEqual([{ connection: 0, streamId: 1, errorCode: CANCEL }]);
  });

  it("reset the stream of a request that timed out", async () => {
    wire = await startH2WireServer({ answer: () => "none" });
    const request = testClient().session().get(`${wire.url}/`, { timeout: 300 });
    await expect(request).rejects.toBeInstanceOf(TimeoutError);
    await waitFor(() => wire.resets.length === 1);
    expect(wire.resets).toEqual([{ connection: 0, streamId: 1, errorCode: CANCEL }]);
  });

  it("reset the stream of a streamed response whose body is cancelled", async () => {
    wire = await startH2WireServer({ answer: () => "headers" });
    const res = await testClient().session().stream(`${wire.url}/`);
    expect(res.status).toBe(200);
    await res.body.cancel();
    await waitFor(() => wire.resets.length === 1);
    expect(wire.resets).toEqual([{ connection: 0, streamId: 1, errorCode: CANCEL }]);
  });

  it("free their slots, so a connection at its stream limit stays usable", async () => {
    wire = await startH2WireServer({
      maxConcurrentStreams: 2,
      answer: (index) => (index < 6 ? "none" : "full"),
    });
    const session = testClient().session();
    for (let i = 0; i < 6; i++) {
      const abandoned = session.get(`${wire.url}/${i}`, { timeout: 200 });
      await expect(abandoned).rejects.toBeInstanceOf(TimeoutError);
    }
    const res = await session.get(`${wire.url}/last`, { timeout: 5_000 });
    expect(res.status).toBe(200);
    expect(wire.connections()).toBe(1);
  });
});

describe("closing a session", () => {
  it("closes its HTTP/2 connections at once", async () => {
    wire = await startH2WireServer();
    const session = testClient().session();
    await session.get(`${wire.url}/`);
    session.close();
    await waitFor(() => wire.closedConnections() === 1, 3_000);
  });
});
