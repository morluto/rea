import { expect, it } from "vitest";

import {
  ESP32C3_APP_SEGMENTS,
  esp8266Image,
  espImage,
} from "../../tests/fixtures/espImage.js";
import { buildFv } from "../../tests/fixtures/uefiImage.js";
import { DEB_AR_HEADER_BYTES, DEB_AR_MAGIC } from "./deb/debPackage.js";
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
import { espIdfCrc32 } from "./firmware/espNvsItemDecoder.js";
import { twoVolumeUbiImage } from "./firmware/ubiImage.fixture.js";
import { buildIso9660Image } from "./iso9660/iso9660.fixture.js";
import { ISO9660_DESCRIPTOR_OFFSET } from "./iso9660/iso9660Structures.js";
import {
  interleaveMegaDriveSmd,
  megaDriveRom,
} from "./megaDriveRom.fixture.js";
import { N64_MAX_ROM_BYTES } from "./n64Rom.js";
import { n64RomImage } from "./n64Rom.fixture.js";

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
  {
    label: "a UBI image with a bad erase-counter header CRC",
    bytes: (() => {
      const bytes = twoVolumeUbiImage();
      bytes.writeUInt32BE(0, 60);
      return bytes;
    })(),
    format: "ubi-image",
    reason: expect.stringContaining("erase-counter header CRC mismatch"),
  },
  {
    label: "a UBI# file shorter than its erase-counter header",
    bytes: twoVolumeUbiImage().subarray(0, 32),
    format: "ubi-image",
    reason: expect.stringContaining("erase-counter header is truncated"),
  },
])("refuses $label in one place", (row) => {
  expect(recognize(row.bytes)).toEqual({
    state: "refused",
    format: row.format,
    reason: row.reason,
    index: expect.any(Number),
  });
});

it("recognizes a Nintendo 64 ROM in every byte order", () => {
  for (const order of ["z64", "v64", "n64"] as const) {
    const encoded = n64RomImage({ order }).encoded;
    expect(recognize(encoded)).toMatchObject({
      state: "recognized",
      format: "n64-rom",
    });
  }
});

it("refuses an odd or implausible Nintendo 64 image and still names an oversized one", () => {
  const encoded = n64RomImage().encoded;
  // A z64 image needs no swap, so its length is free; v64 swaps halves and
  // n64 reverses words.
  expect(recognize(Buffer.concat([encoded, Buffer.from([0])]))).toMatchObject({
    state: "recognized",
    format: "n64-rom",
  });
  for (const [order, extra] of [
    ["v64", 1],
    ["n64", 2],
  ] as const) {
    const odd = Buffer.concat([
      n64RomImage({ order }).encoded,
      Buffer.alloc(extra),
    ]);
    expect(recognize(odd)).toMatchObject({
      state: "refused",
      format: "n64-rom",
      reason: expect.stringMatching(
        new RegExp(`${order} ROM length .* multiple of .*normalized$`, "u"),
      ),
    });
  }
  const badBoot = n64RomImage({ bootAddress: 0 }).encoded;
  expect(recognize(badBoot)).toMatchObject({
    state: "refused",
    format: "n64-rom",
    reason: expect.stringContaining("Boot address"),
  });
  expect(recognize(encoded.subarray(0, 32))).toBeUndefined();
  expect(
    recognizeArtifactFormat({
      prefix: encoded,
      fileSize: N64_MAX_ROM_BYTES + 4,
      espFlashLayout: false,
    }),
  ).toMatchObject({ state: "recognized", format: "n64-rom" });
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

it("recognizes Android DTBO partition table magic prefixes", () => {
  expect(recognize(Buffer.from([0xd7, 0xb7, 0xab, 0x1e]))).toMatchObject({
    state: "recognized",
    format: "android-dtbo",
  });
  expect(recognize(Buffer.from([0xd7, 0xb7, 0xab]))).toBeUndefined();
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

it("recognizes an auditd log by its first record and leaves plain text alone", () => {
  const record = Buffer.from(
    "type=SYSCALL msg=audit(1700000000.123:1000): arch=c000003e syscall=59 success=yes\n",
  );
  expect(recognize(record)).toMatchObject({
    state: "recognized",
    format: "auditd-log",
  });
  expect(recognize(Buffer.from("just some text\nand more\n"))).toBeUndefined();
});

it("decides an auditd claim on a multi-megabyte prefix without overflowing the stack", () => {
  // Format recognition hands every candidate the whole leading buffer, and
  // byte-faithful header decoding spreads its code points into one call. A
  // single spread over a buffer this size throws RangeError instead of
  // answering, which turned every large text member into an adapter failure.
  const binary = Buffer.alloc(4 * 1024 * 1024, 0xff);
  expect(() => recognize(binary)).not.toThrow();
  expect(recognize(binary)).toBeUndefined();
  const record = Buffer.concat([
    Buffer.from("type=SYSCALL msg=audit(1700000000.123:1000): body\n"),
    Buffer.alloc(4 * 1024 * 1024, 0x41),
  ]);
  expect(recognize(record)).toMatchObject({
    state: "recognized",
    format: "auditd-log",
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

it("recognizes a UBI image by its erase-counter header", () => {
  expect(recognize(twoVolumeUbiImage())).toMatchObject({
    state: "recognized",
    format: "ubi-image",
  });
});

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

/** Minimal Unix ar archive with the given members (SysV trailing `/` or BSD `#1/N`). */
const minimalAr = (
  members: readonly {
    readonly name: string;
    readonly data: string;
    readonly bsdName?: boolean;
  }[],
): Buffer => {
  const parts: Buffer[] = [DEB_AR_MAGIC];
  for (const member of members) {
    const payload =
      member.bsdName === true
        ? Buffer.from(`${member.name}${member.data}`, "ascii")
        : Buffer.from(member.data, "ascii");
    const header = Buffer.alloc(DEB_AR_HEADER_BYTES, 0x20);
    const label =
      member.bsdName === true
        ? `#1/${String(member.name.length)}`
        : `${member.name}/`;
    header.write(label.slice(0, 16), 0, "ascii");
    header.write("0", 16, "ascii");
    header.write("0", 28, "ascii");
    header.write("0", 34, "ascii");
    header.write("100644", 40, "ascii");
    header.write(String(payload.length), 48, "ascii");
    header[58] = 0x60;
    header[59] = 0x0a;
    parts.push(header, payload);
    if (payload.length % 2 === 1) parts.push(Buffer.from("\n", "ascii"));
  }
  return Buffer.concat(parts);
};

it("recognizes a Debian package ar archive whose first member is debian-binary", () => {
  const deb = minimalAr([{ name: "debian-binary", data: "2.0\n" }]);
  expect(recognize(deb)).toMatchObject({
    state: "recognized",
    format: "deb",
  });
  const bsdDeb = minimalAr([
    { name: "debian-binary", data: "2.0\n", bsdName: true },
  ]);
  expect(recognize(bsdDeb)).toMatchObject({
    state: "recognized",
    format: "deb",
  });
});

it("recognizes a Mega Drive image and an SMD dump, and yields to ELF", () => {
  const plain = megaDriveRom();
  expect(recognize(plain)).toMatchObject({
    state: "recognized",
    format: "mega-drive-rom",
  });
  const smd = interleaveMegaDriveSmd(megaDriveRom({ imageBytes: 16 * 1024 }));
  expect(recognize(smd)).toMatchObject({
    state: "recognized",
    format: "mega-drive-rom",
  });
  expect(
    recognizeArtifactFormat({
      prefix: smd.subarray(0, 4096),
      fileSize: smd.length,
      espFlashLayout: false,
    }),
  ).toMatchObject({ state: "recognized", format: "mega-drive-rom" });
  // 233 and 489 blocks put 0xE9, the ESP image magic, in the copier
  // header's block-count byte. The SMD signature is decided before the ESP
  // image, and before the ESP flash layout needs another read. The prefix
  // reaches the ISO 9660 descriptor at 32 KiB, as inventory routes read it.
  for (const blocks of [233, 489]) {
    const collides = interleaveMegaDriveSmd(
      megaDriveRom({ imageBytes: blocks * 16 * 1024 }),
    );
    expect(collides[0]).toBe(0xe9);
    for (const espFlashLayout of [false, undefined])
      expect(
        recognizeArtifactFormat({
          prefix: collides.subarray(0, 0x9000),
          fileSize: collides.length,
          espFlashLayout,
        }),
      ).toMatchObject({ state: "recognized", format: "mega-drive-rom" });
  }
  const elf = megaDriveRom();
  elf[0] = 0x7f;
  elf[1] = 0x45;
  elf[2] = 0x4c;
  elf[3] = 0x46;
  expect(recognize(elf)?.format).not.toBe("mega-drive-rom");
  const mz = megaDriveRom();
  mz[0] = 0x4d;
  mz[1] = 0x5a;
  expect(recognize(mz)?.format).not.toBe("mega-drive-rom");
});

it("does not recognize a plain ar archive that is not a Debian package", () => {
  const plainAr = minimalAr([{ name: "hello.o", data: "object" }]);
  expect(recognize(plainAr)).toBeUndefined();
  const lateDebianBinary = minimalAr([
    { name: "hello.o", data: "object" },
    { name: "debian-binary", data: "2.0\n" },
  ]);
  expect(recognize(lateDebianBinary)).toBeUndefined();
  expect(recognize(Buffer.from("!<arch>\n", "ascii"))).toBeUndefined();
});

it("recognizes a standalone ESP-IDF NVS partition and ignores erased or unaligned files", () => {
  const nvs = Buffer.alloc(4096, 0xff);
  nvs.writeUInt32LE(0xffff_fffe, 0);
  nvs.writeUInt32LE(1, 4);
  nvs[8] = 0xfe;
  nvs.writeUInt32LE(espIdfCrc32(nvs.subarray(4, 28)), 28);
  expect(recognize(nvs)).toMatchObject({
    state: "recognized",
    format: "esp-nvs",
  });
  expect(recognize(Buffer.alloc(4096, 0xff))).toBeUndefined();
  expect(
    recognizeArtifactFormat({
      prefix: nvs,
      fileSize: 4100,
      espFlashLayout: false,
    }),
  ).toBeUndefined();
});
