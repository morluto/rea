import { SPLIT_SET_APKS } from "./AndroidSplitSetApks.fixture.js";

/** Whole APK bytes produced by aapt2 from `scripts/fixtures/android/split-set`. */
export const splitSetApk = (name: keyof typeof SPLIT_SET_APKS): Buffer =>
  Buffer.from(SPLIT_SET_APKS[name], "base64");

/** Extract the single stored/deflated `AndroidManifest.xml` of a fixture APK. */
export const manifestBytesOf = async (apk: Buffer): Promise<Uint8Array> => {
  const { inflateRawSync } = await import("node:zlib");
  // Local file header scan: fixtures contain AndroidManifest.xml first.
  let offset = 0;
  while (offset + 30 <= apk.length && apk.readUInt32LE(offset) === 0x04034b50) {
    const method = apk.readUInt16LE(offset + 8);
    const compressed = apk.readUInt32LE(offset + 18);
    const nameLength = apk.readUInt16LE(offset + 26);
    const extraLength = apk.readUInt16LE(offset + 28);
    const name = apk.toString("utf8", offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    if (name === "AndroidManifest.xml") {
      const data = apk.subarray(start, start + compressed);
      return method === 0 ? data : inflateRawSync(data);
    }
    offset = start + compressed;
  }
  throw new Error("fixture has no AndroidManifest.xml local entry");
};
