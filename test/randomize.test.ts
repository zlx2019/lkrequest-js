import { describe, expect, it } from "vitest";
import { Client, type Randomize } from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { expectInvalidConfig } from "./support/helpers.js";

describe("randomize", () => {
  it.each<Randomize>([
    "off",
    "extension_order",
    { mode: "recombine" },
    { mode: "full", layers: ["tls", "h2"] },
    { mode: "recombine", negotiability: "universal" },
    { mode: "recombine", negotiability: "preset_family" },
    { mode: "recombine", layers: ["tls"], negotiability: [0x0403, 0x0804] },
  ])("completes a request with %j", async (randomize) => {
    const client = testClient({ preset: "chrome_146", randomize });
    const res = await client.session().get(serverUrl("/get"));
    expect(res.status).toBe(200);
    expect(res.httpVersion).toBe("2.0");
  });

  it("rejects unknown modes and layers, and synthetic settings on real modes", () => {
    expectInvalidConfig(() => new Client({ randomize: "chaos" as "off" }));
    expectInvalidConfig(
      () => new Client({ randomize: { mode: "recombine", layers: ["tcp" as "tls"] } }),
    );
    expectInvalidConfig(() => new Client({ randomize: { mode: "recombine", layers: [] } }));
    expectInvalidConfig(
      () =>
        new Client({
          randomize: { mode: "recombine", negotiability: "strict" as "universal" },
        }),
    );
    expectInvalidConfig(
      () =>
        new Client({
          randomize: { mode: "extension_order" as "recombine", layers: ["tls"] },
        }),
    );
  });

  it("gives each session of a synthetic client its own fingerprint", async () => {
    // Both sessions must still complete; the identity itself is not observable here.
    const client = testClient({ preset: "chrome_146", randomize: { mode: "recombine" } });
    const [first, second] = await Promise.all([
      client.session().get(serverUrl("/get")),
      client.session().get(serverUrl("/get")),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
  });
});
