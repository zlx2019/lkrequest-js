import { describe, expect, it } from "vitest";
import {
  Client,
  ExtensionType,
  H2Profile,
  type H2ProfileOptions,
  parseH3ControlStream,
  QuicProfile,
  TcpFingerprint,
  TlsProfile,
  validateFingerprintConsistency,
} from "../src/index.js";
import { serverUrl, testClient } from "./support/clients.js";
import { expectInvalidConfig } from "./support/helpers.js";

describe("TlsProfile", () => {
  it("loads every preset, QUIC ClientHellos included", () => {
    const names = TlsProfile.presetNames();
    expect(names).toEqual(expect.arrayContaining(["chrome_155", "chrome_155_quic", "safari_26"]));
    for (const name of names) {
      expect(TlsProfile.preset(name).cipherSuites.length).toBeGreaterThan(0);
    }
    expect(TlsProfile.preset("chrome_155").name).toBe("Chrome 155");
    expectInvalidConfig(() => TlsProfile.preset("chrome_1"));
  });

  it("round-trips through JSON, as a string or an object", () => {
    const profile = TlsProfile.preset("chrome_155");
    const json = profile.toJSON();
    expect(json).toMatchObject({ name: "Chrome 155" });
    expect(TlsProfile.fromJSON(json).toJSON()).toEqual(json);
    expect(TlsProfile.fromJSON(JSON.stringify(profile)).toJSON()).toEqual(json);
    expectInvalidConfig(() => TlsProfile.fromJSON("{"));
  });

  it("builds a profile by hand with lkrequest-py's defaults", () => {
    const profile = TlsProfile.create({
      name: "custom",
      cipherSuites: [0x1301, 0x1302],
      extensions: [
        { extensionType: ExtensionType.SNI as number },
        { extensionType: 0x0a0a, source: "grease" },
        { extensionType: 0xffaa, source: "raw_bytes", rawData: "0001" },
        {
          extensionType: ExtensionType.TRUST_ANCHOR_IDS as number,
          source: "trust_anchor_ids",
          trustAnchorIds: ["d6790902"],
          shuffle: true,
        },
      ],
      supportedGroups: [29, 23],
      grease: { cipherSuite: true },
      padding: { mode: "block_align", minLength: 256, blockSize: 64 },
      shuffleExtensions: true,
    });
    const json = profile.toJSON() as Record<string, unknown>;
    expect(profile.cipherSuites).toEqual([0x1301, 0x1302]);
    expect(profile.alpnProtocols).toEqual(["h2", "http/1.1"]);
    expect(json).toMatchObject({
      tls_min_version: "tls12",
      ec_point_formats: [0],
      session_id_length: 32,
      padding: { type: "block_align", min_length: 256, block_size: 64 },
      randomization: { shuffle_extensions: true },
    });
    const extensions = json.extensions as Array<{ source: { type: string; shuffle?: boolean } }>;
    expect(extensions.map((extension) => extension.source.type)).toEqual([
      "auto",
      "grease",
      "raw_bytes",
      "trust_anchor_ids",
    ]);
    expect(extensions[3]?.source.shuffle).toBe(true);
  });

  it("rejects incomplete or out-of-range specs", () => {
    expectInvalidConfig(() =>
      TlsProfile.create({ name: "x", extensions: [{ extensionType: 1, source: "raw_bytes" }] }),
    );
    expectInvalidConfig(() => TlsProfile.create({ name: "x", cipherSuites: [70_000] }));
    expectInvalidConfig(() => TlsProfile.create({ name: "x", tlsMinVersion: "ssl3" as "tls12" }));
  });

  it("rebuilds a profile from a captured ClientHello", () => {
    const hello = clientHello();
    const profile = TlsProfile.fromClientHello(hello, { name: "captured-test" });
    expect(profile.name).toBe("captured-test");
    expect(profile.cipherSuites).toEqual([0x1301, 0x1302]);
    expectInvalidConfig(() => TlsProfile.fromClientHello(new Uint8Array([1, 2, 3])));
  });
});

describe("H2Profile", () => {
  it("loads presets and reports their priority mapping", () => {
    const profile = H2Profile.preset("chrome_155");
    expect(profile.toJSON()).toHaveProperty("settings");
    expect(profile.priorityConfig).toMatchObject({ streamDepPolicy: expect.any(String) });
    expect(H2Profile.presetNames()).toContain("firefox_156");
    expectInvalidConfig(() => H2Profile.preset("opera_1"));
  });

  it("builds a profile by hand and round-trips it through JSON", () => {
    const profile = H2Profile.create({
      settings: [
        { id: "header_table_size", value: 65_536 },
        { id: 0x99, value: 1 },
      ],
      windowUpdate: 15_663_105,
      pseudoHeaderOrder: ["method", "authority", "scheme", "path"],
      headersPriority: { streamDependency: 0, weight: 255, exclusive: true },
      priorityFrames: [{ streamId: 3, dependency: 0, weight: 200, exclusive: false }],
      priorityConfig: {
        urgencyWeights: [255, 220, 183, 147, 110, 74, 37, 1],
        defaultUrgency: 1,
      },
    });
    expect(profile.priorityConfig).toMatchObject({ defaultUrgency: 1, streamDepPolicy: "flat" });
    expect(H2Profile.fromJSON(profile.toJSON()).toJSON()).toEqual(profile.toJSON());
    expect(
      H2Profile.create({
        settings: [],
        windowUpdate: 0,
        pseudoHeaderOrder: [],
        priorityConfig: "chrome",
      }).priorityConfig,
    ).toMatchObject({ autoPriorityHeader: expect.any(Boolean) });
  });

  it("validates: the presets pass, a profile that breaks HTTP/2's rules does not", () => {
    for (const name of H2Profile.presetNames()) {
      expect(() => H2Profile.preset(name).validate()).not.toThrow();
    }
    const valid: H2ProfileOptions = {
      settings: [{ id: "enable_push", value: 0 }],
      windowUpdate: 15_663_105,
      pseudoHeaderOrder: ["method", "authority", "scheme", "path"],
    };
    expect(() => H2Profile.create(valid).validate()).not.toThrow();
    const invalid: Array<[Partial<H2ProfileOptions>, RegExp]> = [
      [{ pseudoHeaderOrder: [] }, /pseudo_header_order/],
      [{ pseudoHeaderOrder: ["method", "method", "scheme", "path"] }, /pseudo_header_order/],
      [
        {
          settings: [
            { id: "enable_push", value: 0 },
            { id: 2, value: 1 },
          ],
        },
        /duplicate SETTINGS id/,
      ],
      [{ settings: [{ id: "enable_push", value: 2 }] }, /ENABLE_PUSH 2 not 0\/1/],
      [{ settings: [{ id: "initial_window_size", value: 2 ** 31 }] }, /INITIAL_WINDOW_SIZE/],
      [{ settings: [{ id: "max_frame_size", value: 100 }] }, /MAX_FRAME_SIZE 100 out of range/],
      [{ windowUpdate: 2 ** 31 - 1 }, /WINDOW_UPDATE increment/],
    ];
    for (const [change, message] of invalid) {
      const profile = H2Profile.create({ ...valid, ...change });
      expectInvalidConfig(() => profile.validate());
      expect(() => profile.validate()).toThrow(message);
    }
  });

  it("rejects what upstream cannot build", () => {
    const base = { settings: [], windowUpdate: 0, pseudoHeaderOrder: [] };
    expectInvalidConfig(() =>
      H2Profile.create({ ...base, pseudoHeaderOrder: ["status" as "path"] }),
    );
    expectInvalidConfig(() =>
      H2Profile.create({ ...base, settings: [{ id: "nope" as "enable_push", value: 1 }] }),
    );
    expectInvalidConfig(() =>
      H2Profile.create({ ...base, priorityConfig: { urgencyWeights: [1] } }),
    );
    expectInvalidConfig(() => H2Profile.create({ ...base, priorityConfig: { defaultUrgency: 9 } }));
  });

  it("starts requests on the stream id it is given, odd and within 31 bits", () => {
    const base = { settings: [], windowUpdate: 0, pseudoHeaderOrder: [] };
    expect(H2Profile.create(base).initialStreamId).toBe(1);
    const third = H2Profile.create({ ...base, initialStreamId: 3 });
    expect(third.initialStreamId).toBe(3);
    expect(third.toJSON()).toMatchObject({ initial_stream_id: 3 });
    expect(H2Profile.fromJSON(third.toJSON()).initialStreamId).toBe(3);
    for (const initialStreamId of [0, 2, 2 ** 31]) {
      expectInvalidConfig(() => H2Profile.create({ ...base, initialStreamId }));
    }
    expectInvalidConfig(() => H2Profile.fromJSON({ ...third.toJSON(), initial_stream_id: 4 }));
    // JSON saved before the field existed starts at 1.
    const { initial_stream_id: _id, ...older } = third.toJSON();
    expect(H2Profile.fromJSON(older).initialStreamId).toBe(1);
  });

  it("makes streams depend on stream 0, the previous one, or by priority", () => {
    const base = { settings: [], windowUpdate: 0, pseudoHeaderOrder: [] };
    for (const streamDepPolicy of ["flat", "chain", "priority_chain"] as const) {
      const profile = H2Profile.create({ ...base, priorityConfig: { streamDepPolicy } });
      expect(profile.priorityConfig.streamDepPolicy).toBe(streamDepPolicy);
    }
    expectInvalidConfig(() =>
      H2Profile.create({ ...base, priorityConfig: { streamDepPolicy: "tree" as "flat" } }),
    );
  });
});

describe("TcpFingerprint", () => {
  it("loads presets and converts to and from JA4T", () => {
    expect(TcpFingerprint.presetNames()).toEqual(
      expect.arrayContaining(["chrome", "chrome_macos", "firefox_win", "safari"]),
    );
    const ja4t = TcpFingerprint.preset("chrome_win").toJa4t();
    expect(ja4t).toMatch(/^\d+_/);
    expect(TcpFingerprint.fromJa4t(ja4t ?? "").toJa4t()).toBe(ja4t);
    expectInvalidConfig(() => TcpFingerprint.fromJa4t("not-ja4t"));
  });

  it("builds a fingerprint by hand", async () => {
    const fingerprint = TcpFingerprint.create({
      windowSize: 64_240,
      mss: 1460,
      windowScale: 8,
      ttl: 64,
    });
    // JA4T also needs the TCP option list.
    expect(fingerprint.toJa4t()).toBeUndefined();
    const res = await testClient({ tcpFingerprint: fingerprint }).session().get(serverUrl("/get"));
    expect(res.status).toBe(200);
    expectInvalidConfig(() => TcpFingerprint.create({ windowScale: 300 }));
  });

  it("completes the JA4T of a hand-built fingerprint with the TCP option kinds", () => {
    const chromeWin = TcpFingerprint.create({
      windowSize: 64_240,
      tcpOptions: [2, 1, 3, 1, 1, 4],
      mss: 1460,
      windowScale: 8,
    });
    expect(chromeWin.toJa4t()).toBe("64240_2-1-3-1-1-4_1460_8");
    expect(chromeWin.toJa4t()).toBe(TcpFingerprint.preset("chrome_win").toJa4t());
  });

  it("rejects TCP option kinds upstream has no name for", () => {
    expectInvalidConfig(() => TcpFingerprint.create({ tcpOptions: [2, 5] }));
    expectInvalidConfig(() => TcpFingerprint.create({ tcpOptions: [256] }));
    expect(() => TcpFingerprint.create({ tcpOptions: [7] })).toThrow(/tcpOptions kind 7/);
  });

  it("adds the iOS Safari and the empty fingerprint to the presets", () => {
    expect(TcpFingerprint.presetNames()).toEqual(expect.arrayContaining(["safari_ios", "none"]));
    expect(TcpFingerprint.preset("safari_ios").toJa4t()).toBe("65535_2-1-3-1-1-8-4-0_1460_6");
    expect(TcpFingerprint.preset("none").toJa4t()).toBeUndefined();
  });

  it("lets the none preset clear the fingerprint a browser preset brings", () => {
    expect(new Client({ preset: "chrome_155" }).fingerprintInfo().tcpJa4t).toBeDefined();
    const cleared = new Client({ preset: "chrome_155", tcpFingerprint: "none" });
    expect(cleared.fingerprintInfo().tcpJa4t).toBeUndefined();
  });

  it.each([[true], [false], [{ idle: 30_000, interval: 5_000 }], [{ idle: 30_000 }]] as const)(
    "sends requests with keep-alive %j",
    async (keepalive) => {
      const tcpFingerprint = TcpFingerprint.create({ tcpNodelay: true, keepalive });
      const res = await testClient({ tcpFingerprint }).session().get(serverUrl("/get"));
      expect(res.status).toBe(200);
    },
  );

  it("rejects keep-alive timing that is not a duration", () => {
    expectInvalidConfig(() => TcpFingerprint.create({ keepalive: { idle: -1 } }));
    expectInvalidConfig(() => TcpFingerprint.create({ keepalive: { interval: Number.NaN } }));
  });
});

describe("QuicProfile", () => {
  it("loads, validates and round-trips the presets", () => {
    for (const name of QuicProfile.presetNames()) {
      const profile = QuicProfile.preset(name);
      expect(profile.connectionIdLength).toBeGreaterThanOrEqual(0);
      expect(() => profile.validate()).not.toThrow();
      expect(QuicProfile.fromJSON(profile.toJSON()).toJSON()).toEqual(profile.toJSON());
    }
    expectInvalidConfig(() => QuicProfile.preset("firefox_156"));
  });

  it("keeps 62-bit values exact through toJSON() and fromJSON()", () => {
    const profile = QuicProfile.preset("chrome_155");
    const text = JSON.stringify(profile);
    // Chrome's GREASE transport parameter id, beyond Number.MAX_SAFE_INTEGER.
    expect(text).toContain("1706645775112002058");
    expect(JSON.stringify(QuicProfile.fromJSON(profile.toJSON()))).toBe(text);
    expect(JSON.stringify(QuicProfile.fromJSON(text))).toBe(text);
    const changed = QuicProfile.fromJSON({ ...profile.toJSON(), connection_id_length: 8 });
    expect(JSON.stringify(changed)).toContain("1706645775112002058");
  });
});

describe("parseH3ControlStream", () => {
  it("keeps every frame in order, unknown ones and both kinds of priority update included", () => {
    const hex = "00040507010140402102aabb800f07000404753d36800f070106407b693d3f30";
    const parsed = parseH3ControlStream(Buffer.from(hex, "hex"));
    expect(parsed.settings).toEqual([
      { id: 7n, value: 1n },
      { id: 1n, value: 64n },
    ]);
    expect(parsed.frames.map((frame) => frame.frameType)).toEqual([4n, 33n, 0xf0700n, 0xf0701n]);
    expect([...(parsed.frames[1]?.payload ?? [])]).toEqual([0xaa, 0xbb]);
    expect(parsed.priorityUpdates).toEqual([
      { frameType: 0xf0700n, elementId: 4n, fieldValue: "u=6" },
      { frameType: 0xf0701n, elementId: 123n, fieldValue: "i=?0" },
    ]);
  });

  it("keeps all 62 bits of a value, and settings sent twice", () => {
    const hex = "400080000004c000000000000010ffffffffffffffffffffffffffffffff";
    const max = 2n ** 62n - 1n;
    expect(parseH3ControlStream(Buffer.from(hex, "hex")).settings).toEqual([
      { id: max, value: max },
    ]);
    expect(parseH3ControlStream(new Uint8Array([0, 4, 4, 1, 2, 1, 3])).settings).toEqual([
      { id: 1n, value: 2n },
      { id: 1n, value: 3n },
    ]);
    expect(parseH3ControlStream(new Uint8Array([0, 4, 0])).settings).toEqual([]);
  });

  it("rejects bytes that are not a control stream, or that end inside a frame", () => {
    for (const bytes of [[], [0], [0, 4, 1], [0, 4, 1, 1], [2, 4, 0], [0, 33, 0]]) {
      expectInvalidConfig(() => parseH3ControlStream(new Uint8Array(bytes)));
    }
  });
});

describe("clients with custom fingerprints", () => {
  it("takes profile objects and preset names, and reports what it uses", async () => {
    const client = testClient({
      tlsProfile: TlsProfile.preset("chrome_150"),
      h2Profile: "chrome_150",
      tcpFingerprint: "chrome_macos",
      quicFingerprint: "chrome_150_quic",
      quicProfile: QuicProfile.preset("chrome_150"),
    });
    const info = client.fingerprintInfo();
    expect(info.tlsProfile).toBe("Chrome 150");
    expect(info.h2SettingsCount).toBeGreaterThan(0);
    expect(info.tcpJa4t).toBe(TcpFingerprint.preset("chrome_macos").toJa4t());
    expect((await client.session().get(serverUrl("/get"))).status).toBe(200);
  });

  it("lets explicit profiles override the preset's", () => {
    const client = new Client({ preset: "chrome_155", tlsProfile: "firefox_156" });
    expect(client.fingerprintInfo().tlsProfile).toBe("Firefox 156");
  });

  it("accepts a JA4T string as tcpFingerprint", () => {
    const ja4t = TcpFingerprint.preset("firefox_linux").toJa4t() ?? "";
    expect(new Client({ tcpFingerprint: ja4t }).fingerprintInfo().tcpJa4t).toBe(ja4t);
    expectInvalidConfig(() => new Client({ tcpFingerprint: "neither" }));
  });

  it("randomizes the extension order while keeping every other option", async () => {
    const client = testClient({ preset: "chrome_155", timeouts: { total: 10_000 } });
    const randomized = client.randomizeFingerprint();
    expect(randomized).not.toBe(client);
    expect(randomized.fingerprintInfo().tlsProfile).toBe("Chrome 155");
    // The test CA came along, or this would fail certificate verification.
    expect((await randomized.session().get(serverUrl("/get"))).status).toBe(200);
  });
});

describe("validateFingerprintConsistency", () => {
  it("accepts one browser family and warns about mixed ones", () => {
    expect(
      validateFingerprintConsistency({
        tlsProfile: "chrome_155",
        h2Profile: "chrome_155",
        tcpFingerprint: "chrome_macos",
      }),
    ).toEqual({ valid: true, warnings: [] });
    const mixed = validateFingerprintConsistency({
      tlsProfile: "chrome_155",
      h2Profile: "firefox_156",
      tcpFingerprint: "safari",
    });
    expect(mixed.valid).toBe(false);
    expect(mixed.warnings).toHaveLength(2);
    expect(validateFingerprintConsistency({ h2Profile: "firefox_156" }).valid).toBe(true);
  });
});

/** A minimal TLS 1.3 ClientHello handshake message (no record header). */
function clientHello(): Uint8Array {
  const supportedVersions = [0x00, 0x2b, 0x00, 0x03, 0x02, 0x03, 0x04];
  const body = [
    ...[0x03, 0x03], // legacy version
    ...new Array<number>(32).fill(0x11), // random
    0x00, // session ID length
    ...[0x00, 0x04, 0x13, 0x01, 0x13, 0x02], // two cipher suites
    ...[0x01, 0x00], // one compression method
    ...[0x00, supportedVersions.length],
    ...supportedVersions,
  ];
  return new Uint8Array([0x01, 0x00, (body.length >> 8) & 0xff, body.length & 0xff, ...body]);
}
