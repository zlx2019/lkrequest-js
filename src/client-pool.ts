import type { Client } from "./client.js";

/** Options of a {@link ClientPool}. */
export interface ClientPoolOptions {
  /** `"round_robin"` (default) or `"random"`. */
  readonly rotation?: "round_robin" | "random";
}

/**
 * Clients with different fingerprints handed out in rotation, so traffic does not carry one
 * fingerprint throughout. Like lkrequest-py's `ClientPool`, it lives entirely in the binding.
 *
 * @example
 * ```ts
 * const pool = new ClientPool([
 *   new Client({ preset: "chrome_155" }),
 *   new Client({ preset: "firefox_156" }),
 * ]);
 * const res = await pool.acquire().session().get(url);
 * ```
 */
export class ClientPool {
  readonly #clients: Client[];
  readonly #rotation: "round_robin" | "random";
  #next = 0;

  /** Builds a pool; an unknown rotation throws `TypeError`. */
  constructor(clients: Iterable<Client>, options: ClientPoolOptions = {}) {
    const rotation = options.rotation ?? "round_robin";
    if (rotation !== "round_robin" && rotation !== "random") {
      throw new TypeError(`unknown rotation ${JSON.stringify(rotation)}`);
    }
    this.#clients = [...clients];
    this.#rotation = rotation;
  }

  /** Number of clients in the pool. */
  get size(): number {
    return this.#clients.length;
  }

  /** The next client; throws `RangeError` when the pool is empty. */
  acquire(): Client {
    if (this.#clients.length === 0) {
      throw new RangeError("the client pool is empty");
    }
    const index =
      this.#rotation === "random"
        ? Math.floor(Math.random() * this.#clients.length)
        : this.#next++ % this.#clients.length;
    return this.#clients[index] as Client;
  }

  /** Adds a client to the rotation. */
  add(client: Client): void {
    this.#clients.push(client);
  }
}
