import { describe, expect, it } from "vitest";
import { serverUrl, testClient } from "./support/clients.js";

// Ported from the charset tests of lkrequest-py `tests/test_local_server.py`.
const SAMPLE = "中文测试";
const session = testClient().session();

/** Fetches `/charset` with the given query and decodes it with `text(options)`. */
async function text(query: string, options?: { encoding?: string }): Promise<string> {
  const res = await session.get(serverUrl(`/charset?${query}`));
  return res.text(options);
}

describe("Response#text", () => {
  it.each([
    ["gbk", SAMPLE],
    // Big5 is a traditional-Chinese charset and cannot encode the simplified sample.
    ["big5", "中文測試"],
    ["shift_jis", "日本語"],
    ["euc-kr", "한국어"],
  ])("decodes a declared %s body", async (label, sample) => {
    await expect(text(`label=${label}&text=${encodeURIComponent(sample)}`)).resolves.toBe(sample);
  });

  it("decodes as UTF-8 when no charset is declared", async () => {
    await expect(text("label=utf-8&declare=0")).resolves.toBe(SAMPLE);
  });

  it("does not throw for a body that is not UTF-8 and declares nothing", async () => {
    await expect(text("label=gbk&declare=0")).resolves.toContain("�");
  });

  it("lets the encoding argument override a wrong declaration", async () => {
    await expect(text("label=gbk&declare=utf-8", { encoding: "gbk" })).resolves.toBe(SAMPLE);
  });

  it("rejects an unknown encoding argument with RangeError", async () => {
    await expect(text("label=gbk", { encoding: "no-such-codec" })).rejects.toThrow(RangeError);
  });

  it("falls back to UTF-8 for an unknown declared charset", async () => {
    await expect(text("label=utf-8&declare=x-made-up")).resolves.toBe(SAMPLE);
  });

  it("honours and strips a UTF-8 byte order mark over the declared charset", async () => {
    await expect(text("label=utf-8&declare=gbk&bom=1")).resolves.toBe(SAMPLE);
  });

  it("strips the BOM so the body parses as JSON", async () => {
    const res = await session.get(
      serverUrl(`/charset?label=utf-8&bom=1&text=${encodeURIComponent('{"a":1}')}`),
    );
    await expect(res.json()).resolves.toEqual({ a: 1 });
  });
});

describe("StreamingResponse#text", () => {
  /** Streams `/charset` with the given query and decodes it with `text(options)`. */
  async function streamedText(query: string, options?: { encoding?: string }): Promise<string> {
    const res = await session.stream(serverUrl(`/charset?${query}`));
    return res.text(options);
  }

  it("decodes the declared charset", async () => {
    await expect(streamedText("label=gbk")).resolves.toBe(SAMPLE);
  });

  it("lets the encoding argument override the header", async () => {
    await expect(streamedText("label=gbk&declare=utf-8", { encoding: "gbk" })).resolves.toBe(
      SAMPLE,
    );
  });

  it("replaces undecodable bytes rather than throwing", async () => {
    await expect(streamedText("label=gbk&declare=0")).resolves.toContain("�");
  });

  it("rejects an unknown encoding argument with RangeError", async () => {
    await expect(streamedText("label=gbk", { encoding: "no-such-codec" })).rejects.toThrow(
      RangeError,
    );
  });

  it("honours and strips a UTF-8 byte order mark", async () => {
    await expect(streamedText("label=utf-8&declare=gbk&bom=1")).resolves.toBe(SAMPLE);
  });
});
