import { expect, it } from "vitest";

import {
  ESP32C3_APP_SEGMENTS,
  esp8266Image,
  espImage,
} from "../../tests/fixtures/espImage.js";
import { buildFv } from "../../tests/fixtures/uefiImage.js";
import {
  recognizeArtifactFormat,
  recognizesArtifactPrefix,
} from "./artifactFormatRecognition.js";
import {
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "./firmware/androidOtaPayload.fixture.js";
import { sampleAndroidVbmeta } from "./firmware/androidVbmeta.fixture.js";
import {
  buildAndroidSparseImage,
  mixedAndroidSparseImage,
} from "./firmware/androidSparseImage.fixture.js";
import { androidSparseUnsupportedMajor } from "./firmware/androidSparseImage.js";
import { devicetreeFixture } from "./firmware/devicetree.fixture.js";
import { dfuseFile } from "./firmware/dfuse.fixture.js";
import { DFUSE_SUFFIX_BYTES } from "./firmware/dfuse.js";
import { ESP8266_REFUSAL } from "./firmware/espImage.js";
import { buildIso9660Image } from "./iso9660/iso9660.fixture.js";
import { ISO9660_DESCRIPTOR_OFFSET } from "./iso9660/iso9660Structures.js";

/** A classic iNES header declaring one 16 KiB PRG bank, with no bank bytes. */
const headerOnlyInes = (): Buffer => {
  const bytes = Buffer.alloc(16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 0]);
  return bytes;
};

const recognize = (bytes: Buffer, extra: { suffix?: Uint8Array } = {}) =>
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
  {
    label: "an Android sparse image major version 2 header",
    bytes: buildAndroidSparseImage({ majorVersion: 2 }),
    format: "android-sparse-image",
    reason: androidSparseUnsupportedMajor(2),
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
    recognize(bytes, { suffix: bytes.subarray(-DFUSE_SUFFIX_BYTES) }),
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

it("yields the no-magic Qualcomm MBN check to native DOS MZ executables", () => {
  // Valid 1,536-byte DOS MZ executable whose header words also satisfy MBN v3:
  // e_cp=3, e_crlc=0 -> u32(4)=3; e_cparhdr=4 -> 64-byte header; e_sp=256 and
  // e_ip=256 -> u32(16)=u32(20)=256; remaining header words zero.
  const dosMz = Buffer.alloc(1536);
  dosMz.set([0x4d, 0x5a], 0);
  dosMz.writeUInt16LE(3, 4);
  dosMz.writeUInt16LE(4, 8);
  dosMz.writeUInt16LE(256, 16);
  dosMz.writeUInt16LE(256, 20);
  expect(recognize(dosMz)).toBeUndefined();
});

it("recognizes Android boot and vendor boot image prefixes", () => {
  for (const magic of ["ANDROID!", "VNDRBOOT"])
    expect(recognize(Buffer.from(magic))).toMatchObject({
      state: "recognized",
      format: "android-boot-image",
    });
});

it("recognizes a standalone AVB0 vbmeta image and leaves an AVBf footer", () => {
  expect(recognize(sampleAndroidVbmeta())).toMatchObject({
    state: "recognized",
    format: "android-vbmeta",
  });
  expect(recognize(Buffer.from("AVB0"))).toMatchObject({
    state: "recognized",
    format: "android-vbmeta",
  });
  expect(recognize(Buffer.from("AVBf"))).toBeUndefined();
});

it("recognizes a CrAU v2 payload after the uImage magic check", () => {
  expect(recognize(fullAndroidOtaPayload())).toMatchObject({
    state: "recognized",
    format: "android-ota-payload",
  });
});

it("recognizes an Android sparse image by its 0xED26FF3A magic", () => {
  expect(recognize(mixedAndroidSparseImage())).toMatchObject({
    state: "recognized",
    format: "android-sparse-image",
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

it("recognizes the descriptor signature at sector 16 or asks for it", () => {
  const { bytes } = buildIso9660Image();
  expect(
    recognizeArtifactFormat({
      prefix: bytes,
      fileSize: bytes.length,
      espFlashLayout: false,
    }),
  ).toMatchObject({ state: "recognized", format: "iso9660" });
  const prefix = bytes.subarray(0, 4096);
  const pending = recognizeArtifactFormat({
    prefix,
    fileSize: bytes.length,
    espFlashLayout: false,
  });
  expect(pending).toMatchObject({ state: "needs-input", format: "iso9660" });
  expect(
    recognizeArtifactFormat(
      {
        prefix,
        fileSize: bytes.length,
        espFlashLayout: false,
        iso9660Descriptor: bytes.subarray(
          ISO9660_DESCRIPTOR_OFFSET,
          ISO9660_DESCRIPTOR_OFFSET + 7,
        ),
      },
      pending?.index,
    ),
  ).toMatchObject({ state: "recognized", format: "iso9660" });
  expect(
    recognizeArtifactFormat({
      prefix: Buffer.alloc(40_000),
      fileSize: 40_000,
      espFlashLayout: false,
    }),
  ).toBeUndefined();
});

it("leaves descriptor version support to the ISO 9660 parser", () => {
  const { bytes } = buildIso9660Image();
  bytes[ISO9660_DESCRIPTOR_OFFSET + 6] = 3;
  expect(
    recognizeArtifactFormat({
      prefix: bytes,
      fileSize: bytes.length,
      espFlashLayout: false,
    }),
  ).toMatchObject({ state: "recognized", format: "iso9660" });
});

it("recognizes an image that ends inside its first descriptor sector", () => {
  const { bytes } = buildIso9660Image();
  const truncated = bytes.subarray(0, ISO9660_DESCRIPTOR_OFFSET + 7);
  expect(
    recognizeArtifactFormat({
      prefix: truncated,
      fileSize: truncated.length,
      espFlashLayout: false,
    }),
  ).toMatchObject({ state: "recognized", format: "iso9660" });
  expect(
    recognizeArtifactFormat({
      prefix: truncated.subarray(0, -1),
      fileSize: truncated.length - 1,
      espFlashLayout: false,
    }),
  ).toBeUndefined();
});

it("lets a prefix the table recognizes outrank whole-file firmware probes", () => {
  // A sector-aligned file extent can hold a complete firmware volume.
  const volume = buildFv({ files: [] }).buffer;
  const { bytes } = buildIso9660Image({
    files: [{ path: "bios.fd", bytes: volume }],
  });
  expect(bytes.includes("_FVH", 0, "ascii")).toBe(true);
  expect(recognizesArtifactPrefix(bytes, bytes.length)).toBe(true);
  // Claims that wait on more input do not count, and a bare volume claims
  // nothing the table recognizes.
  expect(recognizesArtifactPrefix(bytes.subarray(0, 4096), bytes.length)).toBe(
    false,
  );
  expect(recognizesArtifactPrefix(volume, volume.length)).toBe(false);
});
