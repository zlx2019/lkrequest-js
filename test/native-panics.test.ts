import { describe, expect, it } from "vitest";
import { native } from "../src/internal/native.js";

const { testing } = native;

// A panic must not cross the FFI boundary: there it aborts the whole process. Entry points
// that call upstream synchronously use `catch_unwind`; napi-rs contains panics in futures.
describe("native panics", () => {
  it("surface as a thrown error from a synchronous entry point", () => {
    expect(() => testing.panicSync("synchronous boom")).toThrow(/synchronous boom/);
  });

  it("reject the promise of an asynchronous entry point", async () => {
    await expect(testing.panicAsync("asynchronous boom")).rejects.toThrow();
  });
});
