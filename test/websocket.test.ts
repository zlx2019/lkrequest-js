import { describe, expect, it } from "vitest";
import { AbortError, pendingRequests, RequestError, WebSocketConnection } from "../src/index.js";
import { server, testClient } from "./support/clients.js";
import { waitFor } from "./support/helpers.js";

const wsUrl = (path: string): string => `${server.url.replace("https://", "wss://")}${path}`;
const session = testClient().session();

/** The request target and `Host` header `/ws-echo` saw for this connection's handshake. */
async function handshakeSeen(ws: WebSocketConnection): Promise<{ raw_path: string; host: string }> {
  await ws.send("__handshake__");
  const message = await ws.receive();
  if (message.type !== "text") {
    throw new Error(`expected a text message, got ${message.type}`);
  }
  return JSON.parse(message.data) as { raw_path: string; host: string };
}

describe("session.websocket", () => {
  it("completes the handshake and echoes text and binary messages", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    expect(ws).toBeInstanceOf(WebSocketConnection);
    expect(ws.url).toBe(wsUrl("/ws-echo"));
    await ws.send("hello");
    await expect(ws.receive()).resolves.toEqual({ type: "text", data: "hello" });
    await ws.send(new Uint8Array([1, 2, 3]));
    const binary = await ws.receive();
    expect(binary.type).toBe("binary");
    expect([...(binary as { data: Buffer }).data]).toEqual([1, 2, 3]);
    await ws.close();
    expect(ws.closed).toBe(true);
  });

  it("sends custom handshake headers", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"), {
      headers: [["x-test", "1"]],
      protocols: ["chat"],
    });
    await ws.send("ok");
    await expect(ws.receive()).resolves.toEqual({ type: "text", data: "ok" });
    await ws.close();
  });

  it("rejects an endpoint that does not upgrade", async () => {
    await expect(session.websocket(wsUrl("/get"))).rejects.toThrow(/WebSocket upgrade failed/);
  });

  it("aborts the handshake", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.websocket(wsUrl("/ws-echo"), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it.each([999, 1004, 1005, 1006, 1015, 2000, 5000])(
    "refuses close code %i and stays open",
    async (code) => {
      const ws = await session.websocket(wsUrl("/ws-echo"));
      await expect(ws.close(code)).rejects.toBeInstanceOf(RequestError);
      expect(ws.closed).toBe(false);
      // Rejected before anything reached the wire, so the connection still works.
      await ws.send("still open");
      await expect(ws.receive()).resolves.toMatchObject({ type: "text" });
      await ws.close(1000);
    },
  );

  it("limits the close reason to what fits in a control frame", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    await expect(ws.close(1000, "x".repeat(124))).rejects.toBeInstanceOf(RequestError);
    await ws.close(1000, "x".repeat(123));
    expect(ws.closed).toBe(true);
  });

  it("refuses to send after close", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    await ws.close();
    await expect(ws.send("late")).rejects.toMatchObject({ kind: "connection_closed" });
  });

  it("sends pings, answered with pongs", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    await ws.ping(new Uint8Array([9]));
    await expect(ws.receive()).resolves.toMatchObject({ type: "pong" });
    await ws.close();
  });

  it("iterates the messages until close() ends the iteration", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    await ws.send("a");
    await ws.send("b");
    const seen: string[] = [];
    for await (const message of ws) {
      if (message.type === "text") {
        seen.push(message.data);
      }
      if (seen.length === 2) {
        break;
      }
    }
    expect(seen).toEqual(["a", "b"]);
    await ws.close();
  });

  it("sends while a receive waits for a message", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    const pending = ws.receive();
    await waitFor(() => pendingRequests() > 0);
    // The echo the receive waits for exists only once this send has gone out.
    await ws.send("crossing");
    await expect(pending).resolves.toEqual({ type: "text", data: "crossing" });
    await ws.close();
  });

  it("closes while a receive waits, which then gets the peer's close message", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    const pending = ws.receive();
    await waitFor(() => pendingRequests() > 0);
    await ws.close(1000, "bye");
    await expect(pending).resolves.toMatchObject({ type: "close", code: 1000 });
    await expect(ws.receive()).rejects.toMatchObject({ kind: "connection_closed" });
    await waitFor(() => pendingRequests() === 0);
  });

  it("ends the iteration after the close handshake that close() starts", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    const iteration = (async () => {
      const seen: string[] = [];
      for await (const message of ws) {
        seen.push(message.type);
      }
      return seen;
    })();
    await waitFor(() => pendingRequests() > 0);
    await ws.close();
    await expect(iteration).resolves.toEqual(["close"]);
    await waitFor(() => pendingRequests() === 0);
  });

  it("closes on Symbol.asyncDispose", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    await ws[Symbol.asyncDispose]();
    expect(ws.closed).toBe(true);
  });
});

describe("the upgrade request", () => {
  it("uses an origin-form request target (RFC 9112 §3.2.1)", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    try {
      expect((await handshakeSeen(ws)).raw_path).toBe("/ws-echo");
    } finally {
      await ws.close();
    }
  });

  it("carries the port in Host (RFC 9110 §7.2)", async () => {
    const ws = await session.websocket(wsUrl("/ws-echo"));
    try {
      expect((await handshakeSeen(ws)).host).toBe(new URL(server.url).host);
    } finally {
      await ws.close();
    }
  });
});
