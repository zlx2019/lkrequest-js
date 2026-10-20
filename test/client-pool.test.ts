import { describe, expect, it } from "vitest";
import { Client, ClientPool } from "../src/index.js";

describe("ClientPool", () => {
  const clients = [new Client({ preset: "chrome_155" }), new Client({ preset: "firefox_156" })];

  it("hands clients out round robin", () => {
    const pool = new ClientPool(clients);
    expect(pool.size).toBe(2);
    expect([pool.acquire(), pool.acquire(), pool.acquire()]).toEqual([
      clients[0],
      clients[1],
      clients[0],
    ]);
  });

  it("hands every client out with random rotation", () => {
    const pool = new ClientPool(clients, { rotation: "random" });
    const seen = new Set<Client>();
    for (let i = 0; i < 100 && seen.size < 2; i++) {
      seen.add(pool.acquire());
    }
    expect(seen.size).toBe(2);
  });

  it("grows with add()", () => {
    const pool = new ClientPool([]);
    expect(() => pool.acquire()).toThrow(RangeError);
    pool.add(clients[0] as Client);
    expect(pool.size).toBe(1);
    expect(pool.acquire()).toBe(clients[0]);
  });

  it("rejects an unknown rotation", () => {
    expect(() => new ClientPool(clients, { rotation: "lru" as "random" })).toThrow(TypeError);
  });
});
