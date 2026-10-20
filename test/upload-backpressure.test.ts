import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RequestError } from "../src/index.js";
import { testClient } from "./support/clients.js";

// A streamed request body is pulled only when upstream's transport has room for the next
// chunk. A plain Node.js HTTP server that stops reading makes the connection's backpressure
// observable.

const CHUNK_SIZE = 64 * 1024;
const TOTAL_SIZE = 64 * 1024 * 1024;

/** What the test server saw of one request body. */
interface ReceivedBody {
  received: number;
  sha256: string;
}

/** A local HTTP server that holds off reading request bodies until `resume()` is called. */
interface UploadServer {
  url: string;
  uploads: ReceivedBody[];
  resume(): void;
}

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Starts an {@link UploadServer} on a random loopback port. */
async function startServer(): Promise<UploadServer> {
  let resume: () => void = () => {};
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const uploads: ReceivedBody[] = [];
  const server = createServer(async (req, res) => {
    req.pause();
    await resumed;
    const hash = createHash("sha256");
    let received = 0;
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        hash.update(chunk);
        received += chunk.length;
      }
    } catch {
      return; // the client aborted the upload
    }
    uploads.push({ received, sha256: hash.digest("hex") });
    res.end("ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/upload`, uploads, resume };
}

/** A generated body source that records how far it has been read. */
function createSource(total: number) {
  const hash = createHash("sha256");
  const state = { pulled: 0 };
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let index = 0; state.pulled < total; index++) {
      await nextTurn(); // a real source produces its chunks asynchronously
      const chunk = Buffer.alloc(CHUNK_SIZE, index & 0xff);
      state.pulled += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
  }
  return { body: chunks(), state, digest: () => hash.digest("hex") };
}

/** Samples `read` until it stops changing for `samples` consecutive intervals. */
async function waitUntilStable(read: () => number, samples = 5, intervalMs = 100): Promise<number> {
  let last = -1;
  let unchanged = 0;
  while (unchanged < samples) {
    await sleep(intervalMs);
    const current = read();
    unchanged = current === last && current > 0 ? unchanged + 1 : 0;
    last = current;
  }
  return last;
}

describe("streaming upload backpressure", () => {
  it("pulls chunks only as fast as the connection drains them", async () => {
    const server = await startServer();
    const source = createSource(TOTAL_SIZE);
    const upload = testClient().session().post(server.url, { body: source.body });

    const stalledAt = await waitUntilStable(() => source.state.pulled);
    console.info(`upload: ${stalledAt / 1024 / 1024} MiB pulled while the server was paused`);
    // Bounded by socket and transport buffers, not by the size of the body.
    expect(stalledAt).toBeLessThan(TOTAL_SIZE / 4);

    server.resume();
    await expect(upload).resolves.toMatchObject({ status: 200 });
    expect(server.uploads).toEqual([{ received: TOTAL_SIZE, sha256: source.digest() }]);
  });

  it("aborts the upload when the source fails", async () => {
    const server = await startServer();
    server.resume();
    const failure = new Error("source broke");
    async function* broken(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 3; i++) {
        yield Buffer.alloc(CHUNK_SIZE);
      }
      throw failure;
    }
    const error = await testClient()
      .session()
      .post(server.url, { body: broken() })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RequestError);
    expect((error as RequestError).cause).toBe(failure);
    expect(server.uploads).toEqual([]);
  });
});
