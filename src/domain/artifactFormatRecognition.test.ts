import { expect, it } from "vitest";

import {
  ESP32C3_APP_SEGMENTS,
  esp8266Image,
  espImage,
} from "../../tests/fixtures/espImage.js";
import {
  ARTIFACT_RECOGNITION_TAIL_BYTES,
  recognizeArtifactFormat,
} from "./artifactFormatRecognition.js";
import { elf } from "./binaryTarget.fixture.js";
import { createPakFixture } from "../../tests/fixtures/unreal/pak.js";
import {
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "./firmware/androidOtaPayload.fixture.js";
import { devicetreeFixture } from "./firmware/devicetree.fixture.js";
import { dfuseFile } from "./firmware/dfuse.fixture.js";
import { ESP8266_REFUSAL } from "./firmware/espImage.js";

/** A classic iNES header declaring one 16 KiB PRG bank, with no bank bytes. */
const headerOnlyInes = (): Buffer => {
  const bytes = Buffer.alloc(16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 0]);
  return bytes;
};

const recognize = (bytes: Buffer, extra: { tail?: Uint8Array } = {}) =>
  recognizeArtifactFormat({
    prefix: bytes,
    fileSize: bytes.length,
    espFlashLayout: false,
    ...extra,
  });

// Binary target resolution refuses these files and inventory keeps them as
// plain files; both now act on this one refusal instead of their own checks.
it.each([
  {
    label: "a header-only iNES region",
    bytes: headerOnlyInes(),
    format: "ines",
    reason: expect.stringContaining("iNES"),
  },
  {
    label: "an ESP8266 image",
    bytes: esp8266Image(),
    format: "esp-image",
    reason: ESP8266_REFUSAL,
  },
  {
    label: "an Android OTA payload v1 header",
    bytes: v1AndroidOtaPayload(),
    format: "android-ota-payload",
    reason: expect.stringContaining("major version 1"),
  },
])("refuses $label in one place", (row) => {
  expect(recognize(row.bytes)).toEqual({
    state: "refused",
    format: row.format,
    reason: row.reason,
    index: expect.any(Number),
  });
});

it("asks for the DFU trailer only when the prefix claims DfuSe", () => {
  const bytes = dfuseFile({
    targets: [{ alternateSetting: 0, elements: [{ address: 0, data: [1] }] }],
  });
  const claim = recognize(bytes);
  expect(claim).toMatchObject({ state: "needs-input", format: "dfuse" });
  expect(
    recognize(bytes, {
      tail: bytes.subarray(-ARTIFACT_RECOGNITION_TAIL_BYTES),
    }),
  ).toEqual({ state: "recognized", format: "dfuse", index: claim?.index });
});

it("decides an ESP flash layout before the bootloader image it begins with", () => {
  const bytes = espImage({ segments: ESP32C3_APP_SEGMENTS });
  const pending = recognizeArtifactFormat({
    prefix: bytes,
    fileSize: bytes.length,
  });
  expect(pending).toMatchObject({
    state: "needs-input",
    format: "esp-flash-image",
  });
  const input = { prefix: bytes, fileSize: bytes.length };
  expect(
    recognizeArtifactFormat({ ...input, espFlashLayout: true }, pending?.index),
  ).toMatchObject({ state: "recognized", format: "esp-flash-image" });
  expect(
    recognizeArtifactFormat(
      { ...input, espFlashLayout: false },
      pending?.index,
    ),
  ).toMatchObject({ state: "recognized", format: "esp-image" });
});

it("leaves bytes no recognizer claims to the native and named-format routes", () => {
  expect(recognize(Buffer.from("plain text content\n"))).toBeUndefined();
  expect(recognize(Buffer.from("ANDROID"))).toBeUndefined();
});

it("recognizes Android boot and vendor boot image prefixes", () => {
  for (const magic of ["ANDROID!", "VNDRBOOT"])
    expect(recognize(Buffer.from(magic))).toMatchObject({
      state: "recognized",
      format: "android-boot-image",
    });
});

it("recognizes a CrAU v2 payload after the uImage magic check", () => {
  expect(recognize(fullAndroidOtaPayload())).toMatchObject({
    state: "recognized",
    format: "android-ota-payload",
  });
});

it.each([16, 17])(
  "recognizes FIT from an FDT v%s structure in a bounded prefix",
  (version) => {
    const bytes = devicetreeFixture(
      { name: "", children: [{ name: "images" }] },
      version,
    );
    const structureOffset = bytes.readUInt32BE(8);
    const prefix = bytes.subarray(0, structureOffset + 20);
    expect(
      recognizeArtifactFormat({
        prefix,
        fileSize: bytes.length,
        espFlashLayout: false,
      }),
    ).toMatchObject({ state: "recognized", format: "fit" });
  },
);

it("keeps FIT recognition within the v16 structure block before the strings block", () => {
  const bytes = devicetreeFixture(
    { name: "", children: [{ name: "images" }] },
    16,
  );
  const strings = bytes.readUInt32BE(8) + 8;
  bytes.writeUInt32BE(strings, 12);
  bytes.writeUInt32BE(bytes.length - strings, 32);
  // The /images node lies outside the structure block, so this is a plain DTB.
  expect(recognize(bytes)).toMatchObject({
    state: "recognized",
    format: "devicetree",
  });
});

it.each([16, 17])(
  "refuses an overlapping v%s structure and strings declaration as a devicetree",
  (version) => {
    const bytes = devicetreeFixture(
      { name: "", children: [{ name: "images" }] },
      version,
    );
    const structure = bytes.readUInt32BE(8);
    bytes.writeUInt32BE(structure - 8, 12);
    bytes.writeUInt32BE(16, 32);
    expect(recognize(bytes)).toMatchObject({
      state: "refused",
      format: "devicetree",
      reason: "Overlapping FDT blocks",
    });
  },
);

it.each([8, 12, 19])(
  "does not recognize FIT when the declared structure ends after %s bytes",
  (structureSize) => {
    const bytes = devicetreeFixture({
      name: "",
      children: [{ name: "images" }],
    });
    bytes.writeUInt32BE(structureSize, 36);
    expect(recognize(bytes)).toMatchObject({
      state: "recognized",
      format: "devicetree",
    });
  },
);

/** Recognize a file from a short prefix and, when given, its recognition tail. */
const recognizeFromEnds = (bytes: Buffer, withTail: boolean) =>
  recognizeArtifactFormat({
    prefix: bytes.subarray(0, 16),
    fileSize: bytes.length,
    espFlashLayout: false,
    ...(withTail
      ? { tail: bytes.subarray(-ARTIFACT_RECOGNITION_TAIL_BYTES) }
      : {}),
  });

it.each([
  "v1",
  "v3",
  "v4",
  "v7",
  "v8a",
  "v8b",
  "v9",
  "v10",
  "v11",
  "v12",
] as const)(
  "recognizes an Unreal pak %s footer only from the file's tail",
  (layout) => {
    const { bytes } = createPakFixture({ layout });
    const pending = recognizeFromEnds(bytes, false);
    expect(pending).toMatchObject({
      state: "needs-input",
      format: "unreal-pak",
    });
    expect(recognizeFromEnds(bytes, true)).toEqual({
      state: "recognized",
      format: "unreal-pak",
      index: pending?.index,
    });
    // A prefix holding the whole file is its own tail.
    expect(recognize(bytes)).toMatchObject({
      state: "recognized",
      format: "unreal-pak",
    });
  },
);

it("does not claim a pak footer whose index lies outside the file", () => {
  const { bytes } = createPakFixture({ layout: "v11" });
  const match = recognizeFromEnds(bytes, true);
  expect(match).toMatchObject({ format: "unreal-pak" });
  // v11 footer: key GUID, encryption flag, magic, version, then the index offset.
  const indexAt = bytes.length - 221 + 16 + 1 + 8;
  const outside = Buffer.from(bytes);
  outside.writeBigUInt64LE(BigInt(bytes.length), indexAt);
  expect(recognizeFromEnds(outside, true)).toBeUndefined();
  const empty = Buffer.from(bytes);
  empty.writeBigUInt64LE(0n, indexAt + 8);
  expect(recognizeFromEnds(empty, true)).toBeUndefined();
});

it("leaves a pak footer after an executable header to the executable route", () => {
  const { bytes } = createPakFixture({ layout: "v11" });
  const image = Buffer.concat([elf(2, 1, 62), bytes]);
  const recognized = recognizeArtifactFormat({
    prefix: image.subarray(0, 64),
    fileSize: image.length,
    espFlashLayout: false,
    tail: image.subarray(-ARTIFACT_RECOGNITION_TAIL_BYTES),
  });
  expect(recognized).toBeUndefined();
});
