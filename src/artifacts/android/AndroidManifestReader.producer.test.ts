import { describe, expect, it } from "vitest";

import { readAndroidManifest } from "./AndroidManifestReader.js";
import { manifestBytesOf, splitSetApk } from "./androidSplitSetFixtures.js";

const facts = async (name: Parameters<typeof splitSetApk>[0]) => {
  const result = readAndroidManifest(await manifestBytesOf(splitSetApk(name)));
  if (!result.ok) throw new Error(`${name}: ${result.error.message}`);
  return result.value;
};

describe("readAndroidManifest (aapt2-produced manifests)", () => {
  it("reads base identity, SDK range and sandbox facts", async () => {
    expect(await facts("base")).toEqual({
      package: "dev.rea.fixture",
      version_code: 7,
      version_code_major: null,
      version_name: "1.2.3",
      split: null,
      config_for_split: null,
      is_feature_split: null,
      isolated_splits: true,
      target_sandbox_version: 2,
      is_split_required: null,
      min_sdk_version: 24,
      target_sdk_version: 34,
      unresolved_attributes: [],
    });
  });

  it("reads an ABI config split and its isSplitRequired on <application>", async () => {
    const value = await facts("config-arm64_v8a");
    expect(value.split).toBe("config.arm64_v8a");
    expect(value.config_for_split).toBeNull();
    expect(value.is_split_required).toBe(false);
    expect(value.version_name).toBeNull();
  });

  it("reads a feature split", async () => {
    const value = await facts("feature_x");
    expect(value.split).toBe("feature_x");
    expect(value.is_feature_split).toBe(true);
  });

  it("reads configForSplit as an unnamespaced attribute", async () => {
    const value = await facts("config-feature_x-xxhdpi");
    expect(value.split).toBe("config.xxhdpi");
    expect(value.config_for_split).toBe("feature_x");
  });
});

describe("readAndroidManifest (producer bytes under damage)", () => {
  const base = async () => manifestBytesOf(splitSetApk("base"));

  it("reports a producer manifest cut short as truncated", async () => {
    const bytes = await base();
    expect(
      readAndroidManifest(bytes.subarray(0, bytes.length - 12)),
    ).toMatchObject({ ok: false, error: { kind: "truncated" } });
  });

  it("never throws for arbitrary single-byte corruption", async () => {
    const original = await base();
    for (let index = 0; index < original.length; index += 1) {
      const bytes = Uint8Array.from(original);
      bytes[index] = bytes[index]! ^ 0xff;
      expect(() => readAndroidManifest(bytes)).not.toThrow();
    }
  });
});

describe("readAndroidManifest (version code major)", () => {
  it("reads versionCodeMajor from an aapt2-built manifest", async () => {
    const value = await facts("base-version-major");
    expect(value.version_code).toBe(7);
    expect(value.version_code_major).toBe(1);
  });
});
