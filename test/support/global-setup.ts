import { type ChildProcessByStdio, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

/** Connection details of the local test server (see `test/support/server.py`). */
export interface TestServer {
  /** Base URL, for example `https://127.0.0.1:54321`. */
  url: string;
  /** PEM of the server's self-signed certificate. */
  ca: string;
  /** PEM of that certificate's private key, for servers a test file starts itself. */
  key: string;
  /** Base URL of the same app with HTTP/3 enabled (UDP on the same port). */
  h3Url: string;
  /** That server over IPv6, or `null` when the host cannot bind `::1`. */
  h3UrlIpv6: string | null;
  /** `masque://` URL of the MASQUE test proxy. */
  masqueUrl: string;
  /**
   * Base URL of an HTTP/3 server (UDP only) that closes every connection with
   * H3_INTERNAL_ERROR at its first request; `/_test/h3-closing/stats` on the main server
   * counts its connections.
   */
  h3ClosingUrl: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    server: TestServer;
  }
}

/** First start may download the Python dependencies, so allow for a slow network. */
const STARTUP_TIMEOUT_MS = 180_000;

let server: ChildProcessByStdio<Writable, Readable, Readable> | undefined;

/** Starts the test server and provides its address to every test file. */
export async function setup(project: TestProject): Promise<void> {
  const script = fileURLToPath(new URL("./server.py", import.meta.url));
  // uv logs through RUST_LOG; an inherited value would flood the test output.
  const { RUST_LOG: _rustLog, ...env } = process.env;
  server = spawn("uv", ["run", "--quiet", script], { env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    project.provide("server", await waitForAnnouncement(server));
  } catch (error) {
    server.kill();
    throw error;
  }
}

/** Resolves with the JSON line the server prints once it is listening. */
function waitForAnnouncement(
  child: ChildProcessByStdio<Writable, Readable, Readable>,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const lines = createInterface({ input: child.stdout });
    const onExit = (code: number | null): void => {
      fail(`exited with code ${String(code)} before it started`);
    };
    const timer = setTimeout(() => {
      fail(`did not start within ${STARTUP_TIMEOUT_MS} ms`);
    }, STARTUP_TIMEOUT_MS);

    /** Detaches every listener and timer so nothing keeps the runner alive. */
    function cleanup(): void {
      clearTimeout(timer);
      child.off("exit", onExit);
      lines.close();
    }

    /** Rejects with the reason and whatever the server wrote to stderr. */
    function fail(reason: string): void {
      cleanup();
      reject(new Error(`test server ${reason}:\n${stderr}`));
    }

    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", onExit);
    lines.once("line", (line) => {
      cleanup();
      resolve(JSON.parse(line) as TestServer);
    });
  });
}

/** Stops the test server by closing its stdin, killing it if it does not exit promptly. */
export async function teardown(): Promise<void> {
  if (server === undefined || server.exitCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  server.stdin.end();
  const killer = setTimeout(() => server?.kill(), 5_000);
  await exited;
  clearTimeout(killer);
}
