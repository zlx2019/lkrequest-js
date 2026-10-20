import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as lkrequest from "../src/index.js";
import { native } from "../src/internal/native.js";

// The counterpart of lkrequest-py's test_stub_parity.py, for a build with every feature,
// which is what the tests run against.

/** Names `native/index.d.cts` declares at its top level and in the `testing` namespace. */
function declaredNativeNames(): { top: string[]; testing: string[] } {
  const declarations = readFileSync(new URL("../native/index.d.cts", import.meta.url), "utf8");
  const names = (pattern: RegExp): string[] =>
    [...declarations.matchAll(pattern)].map((match) => match[1] ?? "");
  return {
    top: names(/^export declare (?:class|function) (\w+)/gm),
    testing: names(/^ {2}export function (\w+)/gm),
  };
}

describe("exports", () => {
  it("resolves every value src/index.ts exports", () => {
    const missing = Object.entries(lkrequest)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("loads every class and function the generated typings declare", () => {
    const { top, testing } = declaredNativeNames();
    expect(top.length).toBeGreaterThan(20);
    const bindings = native as unknown as Record<string, unknown>;
    expect(top.filter((name) => typeof bindings[name] !== "function")).toEqual([]);
    const hooks = native.testing as unknown as Record<string, unknown>;
    expect(testing.filter((name) => typeof hooks[name] !== "function")).toEqual([]);
  });

  it("keeps the native layer private", () => {
    const leaked = Object.keys(lkrequest).filter((name) => name.startsWith("Native"));
    expect(leaked).toEqual([]);
    expect(lkrequest).not.toHaveProperty("testing");
  });

  it("reports every feature in this build", () => {
    expect(lkrequest.features()).toEqual({
      quicH3: true,
      masque: true,
      doh: true,
      telemetry: true,
      syntheticFp: true,
    });
  });
});
