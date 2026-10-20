import { createServer, type Socket } from "node:net";

// A plain HTTP/1.1 server that writes back exactly the bytes a test hands it, for responses
// the httpbin server cannot produce: a `Location` in raw UTF-8, a hand-made deflate body.

/** A request as the server received it. */
export interface RawRequest {
  /** The request line, for example `GET /path HTTP/1.1`. */
  readonly line: string;
  /** Header fields in arrival order, names lower-cased and values decoded as latin1. */
  readonly fields: ReadonlyArray<readonly [string, string]>;
  /** Header values by name, as in `fields`; the last one wins where a name repeats. */
  readonly headers: Readonly<Record<string, string>>;
}

/** A running raw HTTP server. */
export interface RawHttpServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Every request received, in arrival order. */
  readonly requests: readonly RawRequest[];
  /** Stops listening and drops every connection. */
  close(): Promise<void>;
}

/**
 * Starts a server on a loopback port. As soon as the head of a request has arrived, `answer`
 * returns the whole response to it, which is written as is before the connection is closed.
 * Request bodies are not read.
 */
export async function startRawHttpServer(
  answer: (request: RawRequest, index: number) => Buffer,
): Promise<RawHttpServer> {
  const requests: RawRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const [line = "", ...lines] = head.subarray(0, end).toString("latin1").split("\r\n");
      const fields: Array<readonly [string, string]> = [];
      const headers: Record<string, string> = {};
      for (const field of lines) {
        const colon = field.indexOf(":");
        const name = field.slice(0, colon).trim().toLowerCase();
        const value = field.slice(colon + 1).trim();
        fields.push([name, value]);
        headers[name] = value;
      }
      const request = { line, fields, headers };
      requests.push(request);
      socket.end(answer(request, requests.length - 1));
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * A complete response that closes the connection, with `Content-Length` added. String header
 * values are written as UTF-8, so a non-ASCII one goes out as raw UTF-8 bytes; pass a `Buffer`
 * for any other bytes.
 */
export function rawResponse(
  status: string,
  headers: ReadonlyArray<readonly [string, string | Buffer]> = [],
  body: Buffer | string = "",
): Buffer {
  const payload = Buffer.from(body);
  const parts = [Buffer.from(`HTTP/1.1 ${status}\r\n`)];
  for (const [name, value] of headers) {
    parts.push(Buffer.from(`${name}: `), Buffer.from(value), Buffer.from("\r\n"));
  }
  parts.push(
    Buffer.from(`Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`),
    payload,
  );
  return Buffer.concat(parts);
}
