import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrokenQuicPolicy,
  Client,
  type ClientOptions,
  type LogRecord,
  type MethodOptions,
  onLog,
  type ProtocolPolicy,
  type RequestPriority,
  type Session,
  setLogLevel,
} from "../src/index.js";
import { h3Url, server, serverUrl, testClient } from "./support/clients.js";
import { startDnsServer, TEST_DOMAIN, type TestDnsServer } from "./support/dns-server.js";
import { expectInvalidConfig, waitFor } from "./support/helpers.js";

/** The parts of a protocol policy, as upstream spells them in its debug log. */
interface LoggedPolicy {
  intent: string;
  acquisition: string;
  upgrade: string;
  fallback: string;
}

/** The records logged while `send` runs, once one with `message` has arrived. */
async function logsDuring(
  directives: string,
  message: string,
  send: () => Promise<unknown>,
): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  const unsubscribe = onLog((record) => records.push(record));
  setLogLevel(directives);
  try {
    await send();
    await waitFor(() => records.some((record) => record.message === message));
    return records;
  } finally {
    setLogLevel("off");
    unsubscribe();
  }
}

/** The protocol policy upstream resolved for the request `send` makes, as it logs it. */
async function resolvedPolicy(send: () => Promise<unknown>): Promise<LoggedPolicy> {
  const records = await logsDuring("lkrequest=debug", "protocol.policy_selected", send);
  const fields = records.find((record) => record.message === "protocol.policy_selected")?.fields;
  const { intent = "", acquisition = "", upgrade = "", fallback = "" } = fields ?? {};
  return { intent, acquisition, upgrade, fallback };
}

/** The policy a request of `session` to `url` resolves to (the main server by default). */
function policyOf(
  session: Session,
  options: MethodOptions = {},
  url: string = serverUrl("/get"),
): Promise<LoggedPolicy> {
  return resolvedPolicy(() => session.get(url, options));
}

describe("preferredHttpVersion", () => {
  it("forces HTTP/1.1 or HTTP/2 for a session", async () => {
    const h1 = testClient().session({ preferredHttpVersion: "http1_only" });
    expect((await h1.get(serverUrl("/get"))).httpVersion).toBe("1.1");
    const h2 = testClient().session({ preferredHttpVersion: "http2_only" });
    expect((await h2.get(serverUrl("/get"))).httpVersion).toBe("2.0");
  });

  it("lets a request override the session, `auto` lifting its restriction", async () => {
    const session = testClient().session({ preferredHttpVersion: "http1_only" });
    const forced = await session.get(serverUrl("/get"), { preferredHttpVersion: "http2_only" });
    expect(forced.httpVersion).toBe("2.0");
    const negotiated = await session.get(serverUrl("/get"), { preferredHttpVersion: "auto" });
    expect(negotiated.httpVersion).toBe("2.0");
  });

  it("rejects an unknown preference", async () => {
    expectInvalidConfig(() => testClient().session({ preferredHttpVersion: "http9" as "auto" }));
    await expect(
      testClient()
        .session()
        .get(serverUrl("/get"), { preferredHttpVersion: "h2" as "auto" }),
    ).rejects.toMatchObject({ name: "TypeError", code: "ERR_LK_INVALID_CONFIG" });
  });
});

describe("protocol policy and intent", () => {
  it.each(["chrome_standard", "chrome_conservative", "crawler_throughput", "h3_strict"] as const)(
    "accepts the %s policy on the client, session and request",
    async (policy) => {
      const session = testClient({ protocolPolicy: policy }).session({ protocolPolicy: policy });
      const res = await session.get(serverUrl("/get"), {
        protocolPolicy: policy,
        httpIntent: "h2_only",
      });
      expect(res.status).toBe(200);
    },
  );

  it("accepts every intent and QUIC failure policy", async () => {
    for (const httpIntent of [
      "h2_only",
      "h3_only",
      "acquire_h3_when_viable",
      "reuse_existing_protocol",
    ] as const) {
      expect(() => testClient().session({ httpIntent })).not.toThrow();
    }
    for (const brokenQuicPolicy of ["strict", "resilient", "disabled"] as const) {
      expect(() => testClient().session({ brokenQuicPolicy })).not.toThrow();
    }
    const session = testClient().session({ httpIntent: "h2_only", brokenQuicPolicy: "resilient" });
    expect((await session.get(serverUrl("/get"))).httpVersion).toBe("2.0");
  });

  it("rejects unknown names", () => {
    expectInvalidConfig(() => new Client({ protocolPolicy: "chrome" as "h3_strict" }));
    expectInvalidConfig(() => testClient().session({ httpIntent: "h3" as "h3_only" }));
    expectInvalidConfig(() => testClient().session({ brokenQuicPolicy: "lenient" as "resilient" }));
  });

  it("accepts the HTTP/3 switches and header order", async () => {
    const client = testClient({
      disableHttp3: true,
      timeouts: { quicConnect: 5_000 },
      h3HeaderOrder: ["host", "user-agent"],
    });
    const session = client.session({ h3HeaderOrder: ["host", "user-agent"] });
    const res = await session.get(serverUrl("/get"), { h3HeaderOrder: ["host", "accept"] });
    expect(res.status).toBe(200);
  });
});

describe("protocol policy objects", () => {
  // Upstream's presets, as it spells them in its debug log.
  const crawler = {
    intent: "ReuseExistingProtocol",
    acquisition: "ReuseExistingFirst",
    upgrade: "Off",
    fallback: "AllowFallback",
  };
  const chrome = {
    intent: "AcquireH3WhenViable",
    acquisition: expect.stringMatching(/^Race\(/),
    upgrade: "ProbeAndMigrate",
    fallback: "AllowFallbackOnNetworkErrors",
  };
  const chromeClient = (options: ClientOptions = {}): Client =>
    testClient({ preset: "chrome_155", ...options });

  // Upstream logs the policy only when a request opens a connection, so each case below sends
  // the first request of a fresh session.

  it("starts from crawler_throughput without a browser preset, and from the preset's own", async () => {
    expect(await policyOf(testClient().session())).toEqual(crawler);
    expect(await policyOf(chromeClient().session())).toEqual(chrome);
  });

  it("keeps the race where the session or the request sets the policy too", async () => {
    const session = chromeClient().session({ protocolPolicy: "chrome_standard" });
    expect(await policyOf(session)).toEqual(chrome);
    const request = await policyOf(chromeClient().session(), { protocolPolicy: "chrome_standard" });
    expect(request).toEqual(chrome);
  });

  it("changes only the given axes of the client's policy", async () => {
    const client = chromeClient({ protocolPolicy: { fallback: "no_fallback" } });
    expect(await policyOf(client.session())).toEqual({ ...chrome, fallback: "NoFallback" });
    const plain = testClient({ protocolPolicy: { upgrade: "probe_only" } });
    expect(await policyOf(plain.session())).toEqual({ ...crawler, upgrade: "ProbeOnly" });
  });

  it("changes only the given axes of the session's and the request's policy", async () => {
    const session = chromeClient().session({ protocolPolicy: { upgrade: "off" } });
    expect(await policyOf(chromeClient().session({ protocolPolicy: { upgrade: "off" } }))).toEqual({
      ...chrome,
      upgrade: "Off",
    });
    // The request starts from the policy its session resolved.
    const request = await policyOf(session, { protocolPolicy: { fallback: "no_fallback" } });
    expect(request).toEqual({ ...chrome, upgrade: "Off", fallback: "NoFallback" });
  });

  it("starts from the preset it names instead", async () => {
    const conservative = await policyOf(chromeClient().session(), {
      protocolPolicy: { preset: "chrome_conservative", upgrade: "off" },
    });
    expect(conservative).toEqual({
      intent: "ReuseExistingProtocol",
      acquisition: "ReuseExistingFirst",
      upgrade: "Off",
      fallback: "AllowFallbackOnNetworkErrors",
    });
  });

  it("brings the other axes in line with an intent, then applies the ones it is given", async () => {
    const h2 = chromeClient().session({ protocolPolicy: { intent: "h2_only" } });
    expect(await policyOf(h2)).toEqual({
      intent: "H2Only",
      acquisition: "EstablishBestAvailable",
      upgrade: "Off",
      fallback: "NoFallback",
    });
    // HTTP/3 only, so the request goes to the HTTP/3 server.
    const h3 = chromeClient().session({
      protocolPolicy: { intent: "h3_only", acquisition: "reuse_existing_first" },
    });
    expect(await policyOf(h3, {}, h3Url("/get"))).toEqual({
      intent: "H3Only",
      acquisition: "ReuseExistingFirst",
      upgrade: "ProbeAndMigrate",
      fallback: "NoFallback",
    });
  });

  it("builds a race from Chrome's defaults and the settings given", async () => {
    const defaults = await policyOf(
      testClient().session({ protocolPolicy: { acquisition: { race: {} } } }),
    );
    expect(defaults.acquisition).toBe(
      "Race(RacePolicy { enable_tcp: true, enable_quic: true, tcp_delay: 300ms, quic_delay: 0ns, only_when_h3_advertised: true })",
    );
    const race = { tcpDelay: 50, quicDelay: 10, onlyWhenH3Advertised: false };
    const custom = await policyOf(
      testClient().session({ protocolPolicy: { acquisition: { race } } }),
    );
    expect(custom.acquisition).toBe(
      "Race(RacePolicy { enable_tcp: true, enable_quic: true, tcp_delay: 50ms, quic_delay: 10ms, only_when_h3_advertised: false })",
    );
  });

  it("refuses a policy that contradicts itself, at every level", async () => {
    const contradictions: Array<[ProtocolPolicy, RegExp]> = [
      [{ intent: "h2_only", fallback: "allow_fallback" }, /H2Only disables H3/],
      [{ intent: "h2_only", upgrade: "probe_only" }, /H2Only disables H3/],
      [{ preset: "h3_strict", fallback: "allow_fallback" }, /H3Only requires NoFallback/],
      [{ intent: "h3_only", acquisition: { race: {} } }, /H3Only cannot race a TCP/],
      [
        { intent: "h2_only", acquisition: { race: { tcp: true, quic: true } } },
        /H2Only cannot race a QUIC/,
      ],
      [{ acquisition: { race: { tcp: false, quic: false } } }, /must enable TCP, QUIC, or both/],
    ];
    for (const [protocolPolicy, message] of contradictions) {
      expectInvalidConfig(() => new Client({ protocolPolicy }));
      expect(() => testClient().session({ protocolPolicy })).toThrow(message);
      await expect(
        testClient().session().get(serverUrl("/get"), { protocolPolicy }),
      ).rejects.toMatchObject({ name: "TypeError", code: "ERR_LK_INVALID_CONFIG" });
    }
  });

  it("rejects unknown names and values that are not a duration", () => {
    const invalid = (protocolPolicy: unknown): void => {
      expectInvalidConfig(() => new Client({ protocolPolicy: protocolPolicy as ProtocolPolicy }));
    };
    invalid({ preset: "chrome" });
    invalid({ intent: "h3" });
    invalid({ acquisition: "fastest" });
    invalid({ upgrade: "always" });
    invalid({ fallback: "never" });
    invalid({ acquisition: {} });
    invalid({ acquisition: { race: { tcpDelay: -1 } } });
    invalid({ acquisition: { race: { quicDelay: Number.NaN } } });
  });

  it("serves a request over HTTP/3 for intent h3_only, from a client with no preset", async () => {
    const session = testClient({ quicProfile: "chrome_155" }).session({
      protocolPolicy: { intent: "h3_only" },
    });
    const res = await session.get(h3Url("/get"), { timeout: 5_000 });
    expect([res.status, res.httpVersion]).toEqual([200, "3.0"]);
  });
});

describe("HTTP/3 advertised but unreachable", () => {
  // The DNS server advertises HTTP/3 for a name that leads to the main server, which speaks
  // TCP only: the client tries QUIC first because the HTTPS record says it may.
  const host = `h3.${TEST_DOMAIN}`;
  const url = `https://${host}:${new URL(server.url).port}/get`;
  let dns: TestDnsServer;

  beforeAll(async () => {
    dns = await startDnsServer({ [host]: "127.0.0.1" }, [host]);
  });

  afterAll(async () => {
    await dns.close();
  });

  // A QUIC handshake that times out (UDP blocked, nothing listening) counts as a failed
  // handshake, so the request falls back to TCP instead of failing with `TimeoutError`.
  it("falls back to TCP when the QUIC handshake times out", async () => {
    const client = testClient({
      preset: "chrome_155",
      dns: { server: dns.address },
      timeouts: { quicConnect: 1_500 },
    });
    expect((await client.session().get(url)).httpVersion).toBe("2.0");
  });
});

describe("brokenQuicPolicy cooldowns", () => {
  // HTTP/3 to a name the server's certificate does not cover fails the QUIC handshake, and
  // upstream answers a failed handshake by keeping the origin on TCP for a while.
  const h3Port = new URL(server.h3Url).port;
  const origin = `uncovered.example.test:${h3Port}`;

  /** The cooldown, in seconds, upstream logs when the HTTP/3 attempt of a session fails. */
  async function cooldownSeconds(brokenQuicPolicy: BrokenQuicPolicy): Promise<string> {
    const client = testClient({
      preset: "chrome_155",
      connectTo: { [origin]: `127.0.0.1:${h3Port}` },
    });
    const session = client.session({ preferredHttpVersion: "http3_only", brokenQuicPolicy });
    const records = await logsDuring("lkrequest=warn", "quic.origin_marked_broken", () =>
      session.get(`https://${origin}/get`, { timeout: 5_000 }).catch(() => undefined),
    );
    const marked = records.find((record) => record.message === "quic.origin_marked_broken");
    return marked?.fields.cooldown_secs ?? "";
  }

  it.each([
    ["strict", "300"],
    ["resilient", "1"],
    [{ initialCooldown: 7_000, maxCooldown: 9_000 }, "7"],
    [{}, "300"],
  ] as const)("keeps the origin on TCP for the cooldown of %j", async (policy, seconds) => {
    expect(await cooldownSeconds(policy)).toBe(seconds);
  });
});

describe("brokenQuicPolicy settings", () => {
  it("accepts every setting", () => {
    expect(() =>
      testClient().session({
        brokenQuicPolicy: {
          initialCooldown: 1_000,
          maxCooldown: 60_000,
          escalationThreshold: 2,
          routeCooldown: 5_000,
          maxEntries: 8,
          maxRouteEntries: 2,
        },
      }),
    ).not.toThrow();
  });

  it.each([
    [{ initialCooldown: -1 }, /initialCooldown/],
    [{ maxCooldown: Number.POSITIVE_INFINITY }, /maxCooldown/],
    [{ routeCooldown: Number.NaN }, /routeCooldown/],
    [{ initialCooldown: 10_000, maxCooldown: 5_000 }, /must not exceed maxCooldown/],
    [{ initialCooldown: 4_000_000 }, /must not exceed maxCooldown/],
    [{ escalationThreshold: 0 }, /escalationThreshold must be at least 1/],
    [{ maxEntries: 0 }, /maxEntries must be at least 1/],
    [{ maxRouteEntries: 0 }, /maxRouteEntries must be at least 1/],
    [{ maxEntries: 1.5 }, /maxEntries must be a non-negative integer/],
  ])("rejects the settings %j", (brokenQuicPolicy, message) => {
    expectInvalidConfig(() => testClient().session({ brokenQuicPolicy }));
    expect(() => testClient().session({ brokenQuicPolicy })).toThrow(message);
  });
});

describe("request priority and idempotency", () => {
  const priorities: RequestPriority[] = [
    "navigation",
    "fetch",
    "css",
    "script",
    "image",
    "background",
    { urgency: 5, incremental: true },
    { urgency: 99 },
  ];

  it.each(priorities)("sends a request with priority %j", async (priority) => {
    const res = await testClient().session().get(serverUrl("/get"), { priority });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown priority preset", async () => {
    await expect(
      testClient()
        .session()
        .get(serverUrl("/get"), { priority: "urgent" as "fetch" }),
    ).rejects.toMatchObject({ code: "ERR_LK_INVALID_CONFIG" });
  });

  it.each(["default", "idempotent", "not_idempotent"] as const)(
    "sends a request declared %s",
    async (idempotency) => {
      const res = await testClient()
        .session()
        .post(serverUrl("/post"), { json: { a: 1 }, idempotency });
      expect(res.status).toBe(200);
    },
  );
});

describe("TLS session resumption", () => {
  it("accepts the advertised resumption presets and switches", () => {
    for (const sessionResumption of ["chrome", "firefox", "disabled"] as const) {
      expect(() => new Client({ sessionResumption })).not.toThrow();
    }
    expect(
      () =>
        new Client({
          preset: "chrome_155",
          sessionResumption: { tls13Psk: false, tls12SessionTicket: true, maxTicketsPerHost: 2 },
        }),
    ).not.toThrow();
    expectInvalidConfig(() => new Client({ sessionResumption: "safari" as "chrome" }));
  });

  it("reports the ticket-cache policy it was given, browser_default by default", () => {
    expect(new Client().tlsSessionResumptionPolicy).toBe("browser_default");
    const disabled = new Client({ tls: { sessionResumptionPolicy: "disabled" } });
    expect(disabled.tlsSessionResumptionPolicy).toBe("disabled");
    const enabled = new Client({ tls: { sessionResumptionPolicy: { maxTicketsPerServer: 5 } } });
    expect(enabled.tlsSessionResumptionPolicy).toEqual({ maxTicketsPerServer: 5 });
  });

  it("rejects a zero ticket capacity, which upstream would panic on", () => {
    expectInvalidConfig(
      () => new Client({ tls: { sessionResumptionPolicy: { maxTicketsPerServer: 0 } } }),
    );
  });

  it.each([
    "unpartitioned",
    "top_level_site",
    "top_level_and_frame_site",
    "chromium",
    "firefox",
  ] as const)("accepts the %s cache partition policy", async (policy) => {
    const client = testClient({ tls: { sessionCachePartitionPolicy: policy } });
    const session = client.session({
      networkPartitionContext: {
        topLevelSite: "https://top.example",
        frameSite: "https://frame.example",
        nonce: "n1",
        browserContext: "ctx",
      },
    });
    expect((await session.get(serverUrl("/get"))).status).toBe(200);
  });

  it("rejects an unknown partition policy", () => {
    expectInvalidConfig(
      () => new Client({ tls: { sessionCachePartitionPolicy: "site" as "chromium" } }),
    );
  });
});

describe("client settings read back", () => {
  it("reports close_notify enforcement, off by default", () => {
    expect(new Client().requireCloseNotify).toBe(false);
    expect(new Client({ tls: { requireCloseNotify: true } }).requireCloseNotify).toBe(true);
  });

  it("reports the HTTP/2 dispatch batch size, 1 by default", () => {
    expect(new Client().h2DispatchBatchSize).toBe(1);
    expect(new Client({ h2: { dispatchBatchSize: 32 } }).h2DispatchBatchSize).toBe(32);
  });
});

describe("h2.dataFramePolicy", () => {
  it.each([
    "browser_default",
    "peer_max_frame_size",
    { fixedPayload: 8_192 },
    { socketWriteAligned: 16_384 },
  ] as const)("uploads with the %j policy", async (dataFramePolicy) => {
    const session = testClient({ h2: { dataFramePolicy } }).session();
    const body = new Uint8Array(100_000).fill(7);
    const res = await session.post(serverUrl("/upload-echo"), { body });
    expect((await res.json()) as unknown).toMatchObject({ length: body.length });
  });

  it("rejects sizes upstream would panic on", () => {
    expectInvalidConfig(() => new Client({ h2: { dataFramePolicy: { fixedPayload: 0 } } }));
    expectInvalidConfig(() => new Client({ h2: { dataFramePolicy: { socketWriteAligned: 9 } } }));
  });
});

describe("fallback.proxyToDirect", () => {
  it("is accepted", () => {
    expect(() => new Client({ fallback: { proxyToDirect: true } })).not.toThrow();
  });
});
