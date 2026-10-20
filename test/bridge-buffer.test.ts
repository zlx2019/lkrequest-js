import { describe, expect, it } from "vitest";
import { native } from "../src/internal/native.js";
import { serverUrl, testClient } from "./support/clients.js";
import { collectGarbage } from "./support/helpers.js";

const { testing } = native;

// Response bytes become a Buffer without a copy, and the finalizer releases the Rust
// allocation exactly once. The large and shared buffers come from the `native.testing`
// hooks; the test server cannot serve bodies that big.

describe("zero-copy Buffer", () => {
  it("hands a response body over without copying it", async () => {
    // Flush pending finalizers first: one running mid-test would move the count.
    await collectGarbage();
    const before = testing.liveExternalBuffers();
    const res = await testClient().session().get(serverUrl("/bytes/4096"));
    const body = await res.bytes();
    expect(body).toHaveLength(4096);
    expect(testing.liveExternalBuffers()).toBe(before + 1);
  });

  it("hands the bytes over without copying them", async () => {
    // Flush pending finalizers first: one running mid-test would move the count.
    await collectGarbage();
    const before = testing.liveExternalBuffers();
    const buffer = await testing.externalBuffer(1024, 7);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer).toHaveLength(1024);
    expect(buffer.every((byte) => byte === 7)).toBe(true);
    // Only the zero-copy path registers a live external buffer.
    expect(testing.liveExternalBuffers()).toBe(before + 1);
  });

  it("copies an empty body", async () => {
    // Flush pending finalizers first: one running mid-test would move the count.
    await collectGarbage();
    const before = testing.liveExternalBuffers();
    await expect(testing.externalBuffer(0, 0)).resolves.toHaveLength(0);
    expect(testing.liveExternalBuffers()).toBe(before);
  });

  it("copies shared bytes, so exporting the same allocation twice is safe", async () => {
    // Flush pending finalizers first: one running mid-test would move the count.
    await collectGarbage();
    const before = testing.liveExternalBuffers();
    const [first, second] = await Promise.all([testing.sharedBuffer(), testing.sharedBuffer()]);
    expect(first.equals(second)).toBe(true);
    first[0] = 0;
    expect(second[0]).toBe(0x5a);
    expect(testing.liveExternalBuffers()).toBe(before);
  });

  it("releases each buffer exactly once after it is collected", async () => {
    await collectGarbage();
    const baseline = testing.liveExternalBuffers();
    let held: Buffer[] | undefined = await Promise.all(
      Array.from({ length: 64 }, () => testing.externalBuffer(1 << 20, 1)),
    );
    expect(testing.liveExternalBuffers()).toBe(baseline + held.length);
    held = undefined;
    await collectGarbage();
    // A second run of any finalizer would push the count below the baseline.
    expect(testing.liveExternalBuffers()).toBe(baseline);
  });

  it("lets V8 account for the external memory without explicit collections", async () => {
    await collectGarbage();
    const baseline = testing.liveExternalBuffers();
    let peak = 0;
    // 1 GiB in total, one buffer referenced at a time. If V8 ignored the external memory, the
    // tiny JS heap would never trigger a collection and every buffer would stay alive.
    for (let i = 0; i < 256; i++) {
      const buffer = await testing.externalBuffer(4 << 20, i & 0xff);
      if (buffer[0] !== (i & 0xff)) {
        throw new Error(`buffer ${i} has unexpected contents`);
      }
      peak = Math.max(peak, testing.liveExternalBuffers() - baseline);
    }
    console.info(`zero-copy: peak live external buffers = ${peak} (4 MiB each)`);
    expect(peak).toBeLessThan(64);
  });
});
