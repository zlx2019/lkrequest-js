import type { AddressInfo } from "node:net";
import { createServer, type TLSSocket } from "node:tls";
import { server as testServer } from "./clients.js";

// Just enough HTTP/2 (RFC 9113) over TLS to see the frames a client sends: the stream id and
// priority of each HEADERS frame and every RST_STREAM. Requests get an empty `200`, or only
// its headers, or nothing, which leaves a stream open for the client to abandon. The header
// blocks are not decoded; the answer is chosen by the order requests arrive in.

const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");

/** Frame types (RFC 9113 §6). */
const HEADERS = 0x1;
const RST_STREAM = 0x3;
const SETTINGS = 0x4;
const PING = 0x6;
const CONTINUATION = 0x9;

/** Frame flags. */
const ACK = 0x1;
const END_STREAM = 0x1;
const END_HEADERS = 0x4;
const PADDED = 0x8;
const PRIORITY = 0x20;

/** SETTINGS_MAX_CONCURRENT_STREAMS. */
const MAX_CONCURRENT_STREAMS = 0x3;

/** HPACK for `:status: 200` (static table index 8). */
const STATUS_200 = Buffer.from([0x88]);

/** The priority a HEADERS frame carried; `weight` as on the wire (the weight minus one). */
export interface SeenPriority {
  readonly dependency: number;
  readonly exclusive: boolean;
  readonly weight: number;
}

/** A HEADERS frame the client sent. */
export interface SeenHeaders {
  /** Number of the connection it came on, from 0. */
  readonly connection: number;
  readonly streamId: number;
  /** Set when the frame had the PRIORITY flag. */
  readonly priority?: SeenPriority;
}

/** An RST_STREAM frame the client sent. */
export interface SeenReset {
  readonly connection: number;
  readonly streamId: number;
  readonly errorCode: number;
}

/**
 * How a request is answered: `full`, an empty `200`; `headers`, a `200` whose body never
 * ends; `none`, nothing at all.
 */
export type H2Answer = "full" | "headers" | "none";

/** Options of {@link startH2WireServer}. */
export interface H2WireOptions {
  /** The answer to the request that arrived `index`-th, from 0 (default: always `full`). */
  readonly answer?: (index: number) => H2Answer;
  /** SETTINGS_MAX_CONCURRENT_STREAMS to announce; unlimited when left out. */
  readonly maxConcurrentStreams?: number;
}

/** A running server and what it has seen. */
export interface H2WireServer {
  /** `https://127.0.0.1:<port>`, served with the test server's certificate. */
  readonly url: string;
  /** HEADERS frames, in arrival order. */
  readonly headers: readonly SeenHeaders[];
  /** RST_STREAM frames, in arrival order. */
  readonly resets: readonly SeenReset[];
  /** Connections accepted so far. */
  connections(): number;
  /** Connections the client has closed so far. */
  closedConnections(): number;
  /** Stops the server and drops its connections. */
  close(): Promise<void>;
}

/** Starts a server on a free port of 127.0.0.1. */
export async function startH2WireServer(options: H2WireOptions = {}): Promise<H2WireServer> {
  const headers: SeenHeaders[] = [];
  const resets: SeenReset[] = [];
  const sockets = new Set<TLSSocket>();
  let accepted = 0;
  let closed = 0;
  const listener = createServer(
    { key: testServer.key, cert: testServer.ca, ALPNProtocols: ["h2"] },
    (socket) => {
      const connection = accepted++;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        closed++;
      });
      socket.write(settingsFrame(options.maxConcurrentStreams));
      const seen = { headers, resets, connection, options };
      let buffer: Buffer = Buffer.alloc(0);
      let prefaceRead = false;
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!prefaceRead) {
          if (buffer.length < PREFACE.length) return;
          buffer = buffer.subarray(PREFACE.length);
          prefaceRead = true;
        }
        buffer = readFrames(buffer, (frame) => handleFrame(socket, frame, seen));
      });
    },
  );
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    headers,
    resets,
    connections: () => accepted,
    closedConnections: () => closed,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        listener.close(() => resolve());
      }),
  };
}

/** One frame off the wire. */
interface Frame {
  readonly type: number;
  readonly flags: number;
  readonly streamId: number;
  readonly payload: Buffer;
}

/** What a connection records into, and how it answers. */
interface Seen {
  readonly headers: SeenHeaders[];
  readonly resets: SeenReset[];
  readonly connection: number;
  readonly options: H2WireOptions;
}

/** Calls `onFrame` for each complete frame in `buffer` and returns the bytes left over. */
function readFrames(buffer: Buffer, onFrame: (frame: Frame) => void): Buffer {
  let rest = buffer;
  while (rest.length >= 9) {
    const length = rest.readUIntBE(0, 3);
    if (rest.length < 9 + length) break;
    onFrame({
      type: rest.readUInt8(3),
      flags: rest.readUInt8(4),
      streamId: rest.readUInt32BE(5) & 0x7fff_ffff,
      payload: rest.subarray(9, 9 + length),
    });
    rest = rest.subarray(9 + length);
  }
  return rest;
}

/** Records a frame and answers what needs an answer. */
function handleFrame(socket: TLSSocket, frame: Frame, seen: Seen): void {
  switch (frame.type) {
    case SETTINGS:
      if (!(frame.flags & ACK)) socket.write(encodeFrame(SETTINGS, ACK, 0));
      break;
    case PING:
      if (!(frame.flags & ACK)) socket.write(encodeFrame(PING, ACK, 0, frame.payload));
      break;
    case HEADERS:
      seen.headers.push({
        connection: seen.connection,
        streamId: frame.streamId,
        ...((frame.flags & PRIORITY) !== 0 && { priority: headersPriority(frame) }),
      });
      if (frame.flags & END_HEADERS) answer(socket, frame.streamId, seen);
      break;
    case CONTINUATION:
      if (frame.flags & END_HEADERS) answer(socket, frame.streamId, seen);
      break;
    case RST_STREAM:
      seen.resets.push({
        connection: seen.connection,
        streamId: frame.streamId,
        errorCode: frame.payload.readUInt32BE(0),
      });
      break;
  }
}

/** The priority fields of a HEADERS frame with the PRIORITY flag. */
function headersPriority(frame: Frame): SeenPriority {
  const offset = frame.flags & PADDED ? 1 : 0;
  const dependency = frame.payload.readUInt32BE(offset);
  return {
    dependency: dependency & 0x7fff_ffff,
    exclusive: (dependency & 0x8000_0000) !== 0,
    weight: frame.payload.readUInt8(offset + 4),
  };
}

/** Answers the request on `streamId` as the options say. */
function answer(socket: TLSSocket, streamId: number, seen: Seen): void {
  const reply = seen.options.answer?.(seen.headers.length - 1) ?? "full";
  if (reply === "none") return;
  const flags = reply === "full" ? END_HEADERS | END_STREAM : END_HEADERS;
  socket.write(encodeFrame(HEADERS, flags, streamId, STATUS_200));
}

/** The server's SETTINGS frame. */
function settingsFrame(maxConcurrentStreams: number | undefined): Buffer {
  if (maxConcurrentStreams === undefined) return encodeFrame(SETTINGS, 0, 0);
  const entry = Buffer.alloc(6);
  entry.writeUInt16BE(MAX_CONCURRENT_STREAMS, 0);
  entry.writeUInt32BE(maxConcurrentStreams, 2);
  return encodeFrame(SETTINGS, 0, 0, entry);
}

/** One frame, ready to write. */
function encodeFrame(
  type: number,
  flags: number,
  streamId: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(9);
  header.writeUIntBE(payload.length, 0, 3);
  header.writeUInt8(type, 3);
  header.writeUInt8(flags, 4);
  header.writeUInt32BE(streamId, 5);
  return Buffer.concat([header, payload]);
}
