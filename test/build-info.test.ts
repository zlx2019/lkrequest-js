import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { features, listPresets, version } from "../src/index.js";

/** Reads the version from package.json, which is the source of truth for releases. */
function packageVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version: string };
  return manifest.version;
}

describe("version", () => {
  it("matches package.json, keeping the crate and package versions in sync", () => {
    expect(version).toBe(packageVersion());
  });
});

describe("features", () => {
  it("reports every optional capability, as both build scripts enable all features", () => {
    expect(features()).toEqual({
      quicH3: true,
      masque: true,
      doh: true,
      telemetry: true,
      syntheticFp: true,
    });
  });
});

describe("listPresets", () => {
  const presets = listPresets();

  it("lists each preset exactly once, including the newest of every family", () => {
    const names = presets.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["chrome_155", "firefox_156", "safari_26"]));
  });

  it("labels each preset with the browser family in its name", () => {
    for (const preset of presets) {
      expect(preset.name.startsWith(`${preset.browser}_`)).toBe(true);
    }
  });

  it("gives HTTP/3 to Chrome presets only, and only when QUIC is compiled in", () => {
    const { quicH3 } = features();
    for (const preset of presets) {
      expect(preset.http3, preset.name).toBe(quicH3 && preset.browser === "chrome");
    }
  });
});
