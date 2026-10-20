import { connect, createServer, type Server, type Socket } from "node:net";

/** Credentials a test proxy requires. */
export interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

/** A forwarding proxy running in the test process. */
export interface TestProxy {
  /** URL to configure the client with, credentials not included. */
  readonly url: string;
  /** Port the proxy listens on. */
  readonly port: number;
  /** Targets of the tunnels it was asked for, as `host:port`, in order. */
  readonly targets: string[];
  /** Headers of each HTTP CONNECT request, lower-cased names (HTTP proxy only). */
  readonly headers: Array<Record<string, string>>;
  /** Stops listening and drops every tunnel. */
  close(): Promise<void>;
}

/** Starts listening on a loopback port and wraps the server as a `TestProxy`. */
async function listen(
  scheme: string,
  handle: (socket: Socket, proxy: TestProxy) => void,
): Promise<TestProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    handle(socket, proxy);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const proxy: TestProxy = {
    url: `${scheme}://127.0.0.1:${port}`,
    port,
    targets: [],
    headers: [],
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  return proxy;
}

/** Connects `client` to `host:port` and pipes both ways, after writing `reply` to `client`. */
function tunnel(client: Socket, host: string, port: number, reply: () => Buffer): void {
  const upstream = connect(port, host, () => {
    client.write(reply());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
}

/**
 * An HTTP `CONNECT` proxy. With `credentials` it answers `407` unless the request carries
 * them in `Proxy-Authorization` (Basic).
 */
export function startConnectProxy(credentials?: ProxyCredentials): Promise<TestProxy> {
  const expected =
    credentials &&
    `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  return listen("http", (socket, proxy) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      // Paused until the tunnel pipes it, so no bytes are lost in between.
      socket.off("data", onData);
      socket.pause();
      const [requestLine = "", ...lines] = head.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const target = requestLine.split(" ")[1] ?? "";
      proxy.targets.push(target);
      proxy.headers.push(headers);
      if (expected && headers["proxy-authorization"] !== expected) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const colon = target.lastIndexOf(":");
      const host = target.slice(0, colon).replace(/^\[|\]$/g, "");
      const rest = head.subarray(end + 4);
      tunnel(socket, host, Number(target.slice(colon + 1)), () => {
        if (rest.length > 0) socket.unshift(rest);
        return Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    };
    socket.on("data", onData);
  });
}

/**
 * A SOCKS5 proxy (RFC 1928, `CONNECT` only). With `credentials` it requires
 * username/password authentication (RFC 1929). Targets sent as domain names (`socks5h`) are
 * recorded by name, the others by address.
 */
export function startSocks5Proxy(credentials?: ProxyCredentials): Promise<TestProxy> {
  return listen("socks5", (socket, proxy) => {
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "request" = "greeting";
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buffer.length < 2 || buffer.length < 2 + (buffer[1] ?? 0)) return;
          const methods = buffer.subarray(2, 2 + (buffer[1] ?? 0));
          buffer = buffer.subarray(2 + methods.length);
          const wanted = credentials ? 0x02 : 0x00;
          if (!methods.includes(wanted)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, wanted]));
          stage = credentials ? "auth" : "request";
        } else if (stage === "auth") {
          const userLength = buffer[1] ?? 0;
          if (buffer.length < 3 + userLength) return;
          const passLength = buffer[2 + userLength] ?? 0;
          if (buffer.length < 3 + userLength + passLength) return;
          const username = buffer.subarray(2, 2 + userLength).toString();
          const password = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString();
          buffer = buffer.subarray(3 + userLength + passLength);
          const ok = username === credentials?.username && password === credentials.password;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            socket.end();
            return;
          }
          stage = "request";
        } else {
          const target = parseSocksTarget(buffer);
          if (!target) return;
          socket.off("data", onData);
          socket.pause();
          const rest = buffer.subarray(target.length);
          proxy.targets.push(`${target.host}:${target.port}`);
          tunnel(socket, target.host, target.port, () => {
            if (rest.length > 0) socket.unshift(rest);
            return Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          });
          return;
        }
      }
    };
    socket.on("data", onData);
  });
}

/** Parses a SOCKS5 `CONNECT` request, or returns `undefined` until it is complete. */
function parseSocksTarget(
  request: Buffer,
): { host: string; port: number; length: number } | undefined {
  if (request.length < 5) return undefined;
  const type = request[3];
  let host: string;
  let offset: number;
  if (type === 0x01) {
    offset = 8;
    if (request.length < offset + 2) return undefined;
    host = [...request.subarray(4, 8)].join(".");
  } else if (type === 0x03) {
    const length = request[4] ?? 0;
    offset = 5 + length;
    if (request.length < offset + 2) return undefined;
    host = request.subarray(5, offset).toString();
  } else {
    offset = 20;
    if (request.length < offset + 2) return undefined;
    const words: string[] = [];
    for (let i = 4; i < 20; i += 2) words.push(request.readUInt16BE(i).toString(16));
    host = words.join(":");
  }
  return { host, port: request.readUInt16BE(offset), length: offset + 2 };
}
