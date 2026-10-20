import { describe, expect, it } from "vitest";
import { Hsts, type LogRecord, onLog, RequestError, setLogLevel } from "../src/index.js";
import { server, testClient } from "./support/clients.js";
import { waitFor } from "./support/helpers.js";

// The test server speaks TLS only, so a plain `http://` request to it fails unless the
// session upgrades it. `localhost` is used because the certificate names it and HSTS ignores
// nothing about it, unlike an IP literal.
const port = new URL(server.url).port;
const plain = (path: string): string => `http://localhost:${port}${path}`;
const secure = (path: string): string => `https://localhost:${port}${path}`;

describe("Hsts", () => {
  it("does not upgrade without a policy or with Hsts.none()", async () => {
    await expect(testClient().session().get(plain("/get"))).rejects.toThrow(RequestError);
    const session = testClient().session({ hsts: Hsts.none() });
    await expect(session.get(plain("/get"))).rejects.toThrow(RequestError);
    expect(Hsts.none().shouldUpgrade("localhost")).toBe(false);
  });

  it("upgrades the hosts of a static policy and their subdomains", async () => {
    const hsts = Hsts.static(["localhost"]);
    const res = await testClient().session({ hsts }).get(plain("/get"));
    expect(res.status).toBe(200);
    expect(res.url).toBe(secure("/get"));
    expect(hsts.shouldUpgrade("api.localhost")).toBe(true);
    expect(hsts.shouldUpgrade("example.com")).toBe(false);
  });

  it("covers the TLDs Chrome preloads only when asked", () => {
    expect(Hsts.static([]).shouldUpgrade("site.dev")).toBe(false);
    expect(Hsts.static([], { preloadedTlds: true }).shouldUpgrade("site.dev")).toBe(true);
  });

  it("starts a dynamic policy from its seed", async () => {
    const res = await testClient()
      .session({ hsts: Hsts.dynamic(["localhost"]) })
      .get(plain("/get"));
    expect(res.status).toBe(200);
  });

  it("learns Strict-Transport-Security and shares it between sessions", async () => {
    const hsts = Hsts.dynamic();
    const client = testClient();
    const first = client.session({ hsts });
    await expect(first.get(plain("/get"))).rejects.toThrow(RequestError);

    const sts = await first.get(
      secure("/response-headers?Strict-Transport-Security=max-age%3D600"),
    );
    expect(sts.headers.get("strict-transport-security")).toBe("max-age=600");
    expect(hsts.shouldUpgrade("localhost")).toBe(true);

    expect((await first.get(plain("/get"))).status).toBe(200);
    expect((await client.session({ hsts }).get(plain("/get"))).status).toBe(200);
  });

  it("forgets a host that sends max-age=0", async () => {
    const hsts = Hsts.dynamic(["localhost"]);
    await testClient()
      .session({ hsts })
      .get(secure("/response-headers?Strict-Transport-Security=max-age%3D0"));
    expect(hsts.shouldUpgrade("localhost")).toBe(false);
  });
});

describe("Hsts.custom", () => {
  it("upgrades the hosts its function names", async () => {
    const asked: string[] = [];
    const hsts = Hsts.custom({
      shouldUpgrade: (host) => {
        asked.push(host);
        return host === "localhost";
      },
    });
    const res = await testClient().session({ hsts }).get(plain("/get"));
    expect([res.status, res.url]).toEqual([200, secure("/get")]);
    expect(asked).toContain("localhost");
  });

  it("leaves the other hosts alone", async () => {
    const hsts = Hsts.custom({ shouldUpgrade: () => false });
    await expect(testClient().session({ hsts }).get(plain("/get"))).rejects.toThrow(RequestError);
  });

  it("answers shouldUpgrade() directly, from the main thread", () => {
    const hsts = Hsts.custom({ shouldUpgrade: (host) => host.endsWith(".example") });
    expect(hsts.shouldUpgrade("a.example")).toBe(true);
    expect(hsts.shouldUpgrade("localhost")).toBe(false);
    const failing = Hsts.custom({
      shouldUpgrade: () => {
        throw new Error("no answer");
      },
    });
    expect(() => failing.shouldUpgrade("localhost")).toThrow("no answer");
  });

  it("learns the hosts recordSts is told about", async () => {
    const known = new Set<string>();
    const recorded: Array<[string, string]> = [];
    const hsts = Hsts.custom({
      shouldUpgrade: (host) => known.has(host),
      recordSts: (host, header) => {
        recorded.push([host, header]);
        known.add(host);
      },
    });
    const session = testClient().session({ hsts });
    await expect(session.get(plain("/get"))).rejects.toThrow(RequestError);
    await session.get(secure("/response-headers?Strict-Transport-Security=max-age%3D600"));
    expect(recorded).toEqual([["localhost", "max-age=600"]]);
    // The next request on any session with this policy is upgraded.
    expect((await testClient().session({ hsts }).get(plain("/get"))).status).toBe(200);
  });

  it("waits for an async recordSts before the next request", async () => {
    let learned = false;
    const hsts = Hsts.custom({
      shouldUpgrade: () => learned,
      recordSts: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        learned = true;
      },
    });
    const session = testClient().session({ hsts });
    await session.get(secure("/response-headers?Strict-Transport-Security=max-age%3D600"));
    expect(learned).toBe(true);
  });

  it("counts an exception or an answer that is not a boolean as no, and logs it", async () => {
    const records: LogRecord[] = [];
    const unsubscribe = onLog((record) => records.push(record));
    setLogLevel("lkrequest_napi=warn");
    try {
      const throwing = Hsts.custom({
        shouldUpgrade: () => {
          throw new Error("policy crashed");
        },
      });
      const wrongType = Hsts.custom({ shouldUpgrade: (() => "yes") as unknown as () => boolean });
      for (const hsts of [throwing, wrongType]) {
        await expect(testClient().session({ hsts }).get(plain("/get"))).rejects.toThrow(
          RequestError,
        );
      }
      await waitFor(
        () => records.filter((record) => /shouldUpgrade failed/.test(record.message)).length >= 2,
      );
      const messages = records.map((record) => record.fields.error ?? "").join("\n");
      expect(messages).toMatch(/policy crashed/);
      expect(messages).toMatch(/must return a boolean, not string/);
    } finally {
      setLogLevel("off");
      unsubscribe();
    }
  });
});

describe("httpsOnly", () => {
  it("allows https:// and refuses http://", async () => {
    const session = testClient().session({ httpsOnly: true });
    expect((await session.get(secure("/get"))).status).toBe(200);
    await expect(session.get(plain("/get"))).rejects.toThrow(RequestError);
  });

  it("allows an http:// URL that HSTS upgrades", async () => {
    const session = testClient().session({ httpsOnly: true, hsts: Hsts.static(["localhost"]) });
    expect((await session.get(plain("/get"))).status).toBe(200);
  });
});
