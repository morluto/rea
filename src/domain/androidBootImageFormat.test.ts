import { expect, it } from "vitest";

import {
  appendAvbFooter,
  buildBootImage,
  buildVendorBootImage,
  declareVendorRamdiskCount,
  osVersionRaw,
  truncateImage,
} from "../../tests/fixtures/androidBootImage.js";
import {
  compressionFromPrefix,
  hasAndroidBootImageMagic,
  inspectAvbFooter,
  parseAndroidBootHeader,
  parseVendorRamdiskTable,
} from "./androidBootImageFormat.js";

const parsed = (bytes: Buffer, fileSize = bytes.length) => {
  const result = parseAndroidBootHeader(bytes.subarray(0, 4096), fileSize);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

const failed = (bytes: Buffer, fileSize = bytes.length) => {
  const result = parseAndroidBootHeader(bytes.subarray(0, 4096), fileSize);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.error;
};

it("recognizes ANDROID! and VNDRBOOT and names compression from a prefix", () => {
  expect(hasAndroidBootImageMagic(Buffer.from("ANDROID!"))).toBe(true);
  expect(hasAndroidBootImageMagic(Buffer.from("VNDRBOOT"))).toBe(true);
  expect(hasAndroidBootImageMagic(Buffer.from("short"))).toBe(false);
  expect(compressionFromPrefix(Buffer.from([0x1f, 0x8b]))).toBe("gzip");
  expect(compressionFromPrefix(Buffer.from([0x04, 0x22, 0x4d, 0x18]))).toBe(
    "lz4",
  );
  expect(compressionFromPrefix(Buffer.from([0x02, 0x21, 0x4c, 0x18]))).toBe(
    "lz4",
  );
  expect(compressionFromPrefix(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe(
    "zstd",
  );
  expect(compressionFromPrefix(Buffer.from("plain"))).toBeNull();
});

it("decodes a v0 command line, OS version, and page-aligned kernel", () => {
  const kernel = Buffer.from("kernel");
  const image = buildBootImage({
    version: 0,
    kernel,
    osVersion: osVersionRaw(13, 0, 0, 2024, 11),
    name: "board",
  });
  expect(image.subarray(2048, 2048 + kernel.length).equals(kernel)).toBe(true);
  const facts = parsed(image);
  expect(facts).toMatchObject({
    imageKind: "boot",
    magic: "ANDROID!",
    headerVersion: 0,
    pageSize: 2048,
    headerSize: 1632,
    osVersionRaw: 436_208_011,
    osVersion: "13.0.0",
    securityPatchLevel: "2024-11",
    name: "board",
    commandLine: "console=tty0 androidboot.hardware=test",
    kernelSize: kernel.length,
    secondSize: 0,
    recoveryDtboSize: null,
    signatureSize: null,
    headerOccupied: 2048,
  });
  expect(facts.components.map((item) => item.path)).toEqual([
    "kernel",
    "ramdisk",
  ]);
  expect(facts.components[0]).toMatchObject({
    offset: 2048,
    size: kernel.length,
    loadAddress: 0x8000_8000,
  });
  expect(facts.limitations).toEqual([
    "Command line, board name, and vendor ramdisk names are target-derived and untrusted.",
    "ANDROID! covers boot, init_boot, and recovery images; the header does not record which role the file had.",
  ]);
});

it("keeps a split UTF-8 name as hex and a non-calendar patch month as raw", () => {
  const image = buildBootImage({
    version: 0,
    name: "测".repeat(6),
    osVersion: osVersionRaw(13, 0, 0, 2024, 13),
  });
  const facts = parsed(image);
  expect(facts.name).toBeNull();
  expect(facts.nameBytesHex).toBe(image.subarray(48, 64).toString("hex"));
  expect(facts.osVersion).toBe("13.0.0");
  expect(facts.securityPatchLevel).toBeNull();
  expect(facts.limitations.join(" ")).toContain("security patch month 13");
});

it("places a v2 DTB after the recovery DTBO and rejects an overlapping offset", () => {
  const dtb = Buffer.from("dtb-bytes");
  const recovery = Buffer.from("dtbo");
  const image = buildBootImage({
    version: 2,
    kernel: Buffer.from("kernel"),
    ramdisk: Buffer.alloc(0),
    recoveryDtbo: recovery,
    dtb,
  });
  expect(image.subarray(2048, 2054).equals(Buffer.from("kernel"))).toBe(true);
  const facts = parsed(image);
  const dtbo = facts.components.find((item) => item.role === "recovery-dtbo");
  const dtbPlan = facts.components.find((item) => item.role === "dtb");
  expect(dtbo).toMatchObject({ path: "recovery_dtbo", offset: 4096 });
  expect(dtbPlan).toMatchObject({
    path: "dtb",
    offset: 6144,
    size: dtb.length,
    loadAddress: 0x8200_0000,
  });
  expect(image.subarray(6144, 6144 + dtb.length).equals(dtb)).toBe(true);
  const overlap = buildBootImage({
    version: 2,
    recoveryDtbo: recovery,
    recoveryDtboOffset: 2048,
    dtb,
  });
  expect(failed(overlap).message).toContain(
    "recovery_dtbo overlaps an earlier component",
  );
});

it("rejects an unsupported version, a bad page size, and a truncated image", () => {
  const version = buildBootImage({ version: 0 });
  version.writeUInt32LE(5, 40);
  expect(failed(version)).toMatchObject({
    _tag: "AndroidBootFormatFailure",
    message: "header version 5 is unsupported",
  });
  const page = buildBootImage({ version: 0 });
  page.writeUInt32LE(1024, 36);
  expect(failed(page).message).toContain("page size 1024");
  expect(
    failed(truncateImage(buildBootImage({ version: 0 }))).message,
  ).toContain("image is truncated");
});

it("aligns a kernel larger than 2^31 without allocating the image", () => {
  const header = Buffer.alloc(1632);
  header.write("ANDROID!", 0, "ascii");
  header.writeUInt32LE(0x8000_0001, 8);
  header.writeUInt32LE(2048, 36);
  const result = parseAndroidBootHeader(header, Number.MAX_SAFE_INTEGER);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.components).toEqual([
    expect.objectContaining({
      role: "kernel",
      path: "kernel",
      offset: 2048,
      size: 0x8000_0001,
    }),
  ]);
  expect(result.value.imageEnd).toBe(0x8000_1000);
});

it("decodes a legacy command line whose UTF-8 character straddles the 512-byte split", () => {
  const image = buildBootImage({ version: 0, cmdline: "", extraCmdline: "" });
  const joined = Buffer.from(`${"a".repeat(511)}\u00e9 quiet`, "utf8");
  joined.copy(image, 64, 0, 512);
  joined.copy(image, 608, 512);
  const facts = parsed(image);
  expect(facts.cmdline).toBeNull();
  expect(facts.extraCmdline).toBeNull();
  expect(facts.cmdlineBytesHex).toBe(joined.subarray(0, 512).toString("hex"));
  expect(facts.commandLine).toBe(`${"a".repeat(511)}\u00e9 quiet`);
});

it("keeps a legacy command line null when the joined bytes are invalid UTF-8", () => {
  const image = buildBootImage({ version: 0, cmdline: "", extraCmdline: "" });
  Buffer.from("a".repeat(511), "utf8").copy(image, 64);
  image[575] = 0xc3;
  image[608] = 0x41;
  expect(parsed(image).commandLine).toBeNull();
});

it("decodes v3 and v4 boot images with a fixed 4096-byte page", () => {
  const kernel = Buffer.from("kern");
  const v3 = parsed(
    buildBootImage({
      version: 3,
      kernel,
      ramdisk: Buffer.from([0x1f, 0x8b, 1]),
      cmdline: "console=tty0",
    }),
  );
  expect(v3).toMatchObject({
    headerVersion: 3,
    pageSize: 4096,
    headerSize: 1580,
    name: null,
    kernelAddr: null,
    extraCmdline: null,
    headerDigestHex: null,
    signatureSize: null,
    commandLine: "console=tty0",
  });
  expect(v3.components.map((item) => item.offset)).toEqual([4096, 8192]);
  expect(v3.cmdlineBytesHex).toHaveLength(3072);
  const signature = Buffer.from("sig");
  const v4 = parsed(
    buildBootImage({
      version: 4,
      kernel,
      ramdisk: Buffer.alloc(0),
      signature,
    }),
  );
  expect(v4.signatureSize).toBe(signature.length);
  expect(v4.components.map((item) => item.role)).toEqual([
    "kernel",
    "signature",
  ]);
  expect(v4.components[1]).toMatchObject({ offset: 8192, path: "signature" });
});

it("splits a v4 vendor ramdisk table and a v3 section", () => {
  const first = Buffer.from("aaa");
  const second = Buffer.from("bbbbb");
  const dtb = Buffer.from("dtb");
  const bootconfig = Buffer.from("androidboot.serialno=abc\n");
  const boardId = Buffer.alloc(64, 0x11);
  boardId.writeUInt32LE(0x11223344, 0);
  const longName = "platform-ramdisk-name-exceeds-32b";
  const storedName = longName.slice(0, 32);
  const image = buildVendorBootImage({
    version: 4,
    ramdisks: [
      { name: longName, type: 1, bytes: first, boardId },
      { name: "platform", type: 2, bytes: second },
    ],
    dtb,
    bootconfig,
  });
  expect(image.subarray(4096, 4099).equals(first)).toBe(true);
  const facts = parsed(image);
  expect(facts).toMatchObject({
    imageKind: "vendor-boot",
    magic: "VNDRBOOT",
    headerVersion: 4,
    pageSize: 4096,
    osVersion: null,
    vendorRamdiskSize: 8,
    vendorRamdiskTableEntryCount: 2,
    vendorRamdiskTableEntrySize: 108,
    bootconfigSize: bootconfig.length,
  });
  expect(facts.cmdlineBytesHex).toHaveLength(4096);
  expect(facts.tableRange).toEqual({ offset: 12288, size: 216 });
  const table = facts.tableRange;
  const section = facts.vendorRamdiskSection;
  if (table === null || section === null) throw new Error("missing table");
  expect(
    image.subarray(table.offset + 12, table.offset + 44).toString("utf8"),
  ).toBe(storedName);
  expect(
    image.subarray(table.offset + 44, table.offset + 108).equals(boardId),
  ).toBe(true);
  const rows = parseVendorRamdiskTable(
    image.subarray(table.offset, table.offset + table.size),
    {
      entryCount: 2,
      entrySize: 108,
      sectionOffset: section.offset,
      sectionSize: section.size,
    },
  );
  expect(rows.ok, JSON.stringify(rows)).toBe(true);
  if (!rows.ok) return;
  expect(rows.value.components.map((item) => item.path)).toEqual([
    `vendor_ramdisk/${storedName}`,
    "vendor_ramdisk/platform",
  ]);
  expect(rows.value.components[0]?.nameBytesHex).toHaveLength(64);
  expect(rows.value.components[0]?.boardIdHex).toBe(boardId.toString("hex"));
  expect(rows.value.components[0]).toMatchObject({
    ramdiskType: 1,
    ramdiskTypeName: "platform",
    offset: 4096,
    size: first.length,
  });
  expect(rows.value.components.map((item) => item.loadAddress)).toEqual([
    null,
    null,
  ]);
  const v3 = buildVendorBootImage({
    version: 3,
    pageSize: 2048,
    ramdisk: Buffer.from("ram"),
  });
  expect(v3.subarray(4096, 4099).equals(Buffer.from("ram"))).toBe(true);
  expect(parsed(v3).components).toEqual([
    expect.objectContaining({
      path: "vendor_ramdisk",
      offset: 4096,
      size: 3,
      loadAddress: 0x8100_0000,
    }),
  ]);
});

it("rejects vendor table overlap, overrun, and an excessive entry count", () => {
  const image = buildVendorBootImage({
    version: 4,
    ramdisks: [
      { name: "one", type: 1, bytes: Buffer.from("aaa") },
      { name: "two", type: 1, bytes: Buffer.from("bbbbb") },
    ],
  });
  const facts = parsed(image);
  const table = facts.tableRange;
  const section = facts.vendorRamdiskSection;
  const entrySize = facts.vendorRamdiskTableEntrySize;
  if (
    table === null ||
    section === null ||
    entrySize === null ||
    facts.vendorRamdiskTableEntryCount === null
  )
    throw new Error("missing table");
  const input = {
    entryCount: facts.vendorRamdiskTableEntryCount,
    entrySize,
    sectionOffset: section.offset,
    sectionSize: section.size,
  };
  const rows = (source: Buffer) =>
    parseVendorRamdiskTable(
      source.subarray(table.offset, table.offset + table.size),
      input,
    );
  const overlap = Buffer.from(image);
  overlap.writeUInt32LE(0, table.offset + entrySize + 4);
  const overlapped = rows(overlap);
  expect(overlapped.ok).toBe(false);
  if (overlapped.ok) return;
  expect(overlapped.error.message).toContain("overlaps entry");
  const overrun = Buffer.from(image);
  overrun.writeUInt32LE(100, table.offset);
  const overran = rows(overrun);
  expect(overran.ok).toBe(false);
  if (overran.ok) return;
  expect(overran.error.message).toContain("overruns the vendor ramdisk");
  const capacity = failed(
    declareVendorRamdiskCount(buildVendorBootImage({ version: 4 }), 4097),
  );
  expect(capacity).toMatchObject({
    _tag: "AndroidBootCapacityFailure",
    limit: {
      name: "Android vendor ramdisk table entry count",
      maximum: 4096,
      unit: "entries",
    },
  });
  expect(capacity.message).toContain("4096");
  expect(
    failed(
      buildVendorBootImage({
        version: 4,
        entrySize: 107,
        ramdisks: [{ name: "short", bytes: Buffer.from("abcd") }],
      }),
    ).message,
  ).toContain("smaller than the 108-byte");
});

it("names unsafe vendor ramdisk paths and reports an uncovered section", () => {
  const entry = (name: string, offset: number): Buffer => {
    const row = Buffer.alloc(108);
    row.writeUInt32LE(4, 0);
    row.writeUInt32LE(offset, 4);
    Buffer.from(name, "utf8").copy(row, 12);
    return row;
  };
  const table = Buffer.concat([
    entry("a/b", 0),
    entry(".", 4),
    entry("same", 8),
    entry("same", 12),
  ]);
  const result = parseVendorRamdiskTable(table, {
    entryCount: 4,
    entrySize: 108,
    sectionOffset: 4096,
    sectionSize: 16,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.components.map((item) => item.path)).toEqual([
    "vendor_ramdisk/ramdisk-0",
    "vendor_ramdisk/ramdisk-1",
    "vendor_ramdisk/same",
    "vendor_ramdisk/same-3",
  ]);
  const uncovered = parsed(
    buildVendorBootImage({
      version: 4,
      section: Buffer.from("uncovered-section"),
    }),
  );
  expect(uncovered.components).toEqual([]);
  expect(uncovered.limitations.join(" ")).toContain(
    "outside the ramdisk table",
  );
  const wide = Buffer.alloc(208);
  wide.writeUInt32LE(4, 0);
  const wideRows = parseVendorRamdiskTable(wide, {
    entryCount: 1,
    entrySize: 208,
    sectionOffset: 4096,
    sectionSize: 4,
  });
  expect(wideRows.ok, JSON.stringify(wideRows)).toBe(true);
  if (!wideRows.ok) return;
  expect(wideRows.value.limitations.join(" ")).toContain("108-byte");
  expect(wideRows.value.components[0]?.nameBytesHex).toHaveLength(64);
  expect(wideRows.value.components[0]?.boardIdHex).toHaveLength(128);
});

it("keeps colliding vendor ramdisk names unique", () => {
  const entry = (name: string, offset: number): Buffer => {
    const row = Buffer.alloc(108);
    row.writeUInt32LE(4, 0);
    row.writeUInt32LE(offset, 4);
    Buffer.from(name, "utf8").copy(row, 12);
    return row;
  };
  const paths = (names: readonly string[]) => {
    const table = Buffer.concat(
      names.map((name, index) => entry(name, index * 4)),
    );
    const result = parseVendorRamdiskTable(table, {
      entryCount: names.length,
      entrySize: 108,
      sectionOffset: 4096,
      sectionSize: names.length * 4,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    return result.value.components.map((item) => item.path);
  };
  expect(paths(["x", "x-2", "x"])).toEqual([
    "vendor_ramdisk/x",
    "vendor_ramdisk/x-2",
    "vendor_ramdisk/x-2-2",
  ]);
  expect(paths(["ramdisk-1", ""])).toEqual([
    "vendor_ramdisk/ramdisk-1",
    "vendor_ramdisk/ramdisk-1-1",
  ]);
  expect(paths(["ramdisk-2", "ramdisk-2-2", "a/b"])).toEqual([
    "vendor_ramdisk/ramdisk-2",
    "vendor_ramdisk/ramdisk-2-2",
    "vendor_ramdisk/ramdisk-2-2-2",
  ]);
});

it("records an AVB footer and rejects vbmeta that overlaps a component", () => {
  const image = buildBootImage({
    version: 0,
    kernel: Buffer.alloc(64, 1),
    ramdisk: Buffer.alloc(0),
  });
  const facts = parsed(image);
  const happy = appendAvbFooter(image);
  const footer = inspectAvbFooter({
    fileSize: happy.length,
    imageEnd: facts.imageEnd,
    headerOccupied: facts.headerOccupied,
    components: facts.components,
    tail: happy.subarray(happy.length - 64),
  });
  expect(footer).toMatchObject({
    ok: true,
    value: {
      present: true,
      footerSize: 64,
      versionMajor: 1,
      versionMinor: 0,
      originalImageSize: image.length,
      vbmetaOffset: image.length,
      limitations: [],
    },
  });
  const bare = inspectAvbFooter({
    fileSize: image.length,
    imageEnd: facts.imageEnd,
    headerOccupied: facts.headerOccupied,
    components: facts.components,
    tail: null,
  });
  expect(bare).toMatchObject({
    ok: true,
    value: { present: false, limitations: [] },
  });
  const short = Buffer.concat([image, Buffer.alloc(10)]);
  const shortFooter = inspectAvbFooter({
    fileSize: short.length,
    imageEnd: facts.imageEnd,
    headerOccupied: facts.headerOccupied,
    components: facts.components,
    tail: null,
  });
  expect(shortFooter.ok).toBe(true);
  if (!shortFooter.ok) return;
  expect(shortFooter.value.limitations[0]).toContain("10 trailing bytes");
  const colliding = appendAvbFooter(image, {
    vbmetaOffset: 2048,
    vbmeta: Buffer.alloc(16),
  });
  const collision = inspectAvbFooter({
    fileSize: colliding.length,
    imageEnd: facts.imageEnd,
    headerOccupied: facts.headerOccupied,
    components: facts.components,
    tail: colliding.subarray(colliding.length - 64),
  });
  expect(collision.ok).toBe(false);
  if (collision.ok) return;
  expect(collision.error.message).toContain(
    "AVB vbmeta overlaps a component at offset 2048",
  );
});
