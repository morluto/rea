import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";

import { expect, it } from "vitest";

import { AndroidBootImageArtifactReader } from "./AndroidBootImageArtifactReader.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  appendAvbFooter,
  buildBootImage,
  buildVendorBootImage,
  osVersionRaw,
  truncateImage,
} from "../../tests/fixtures/androidBootImage.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { elf } from "../domain/binaryTarget.fixture.js";

const writeCarrier = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-android-boot-", name, bytes);

const openAll = async (path: string): Promise<ReadonlyMap<string, Buffer>> => {
  const reader = new AndroidBootImageArtifactReader(path);
  const out = new Map<string, Buffer>();
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    for (const entry of entries)
      out.set(entry.path, await buffer(await reader.open(entry)));
    return out;
  } finally {
    await reader.close();
  }
};

it("classifies boot and vendor_boot bytes by content, not by suffix", () => {
  expect(
    classifyArtifactBytesAtPath("notes.txt", buildBootImage({ version: 0 })),
  ).toEqual({ kind: "container", format: "android-boot-image" });
  expect(
    classifyArtifactBytesAtPath(
      "vendor.bin",
      buildVendorBootImage({ version: 4 }),
    ),
  ).toEqual({ kind: "container", format: "android-boot-image" });
  expect(classifyArtifactBytesAtPath("notes.txt", Buffer.from("nope"))).toEqual(
    { kind: "resource", format: "file" },
  );
});

it("inventories and extracts a v0 image", async () => {
  const kernel = Buffer.from("kernel-bytes");
  const ramdisk = Buffer.from("ramdisk-bytes");
  const path = await writeCarrier(
    "boot.img",
    buildBootImage({
      version: 0,
      kernel,
      ramdisk,
      osVersion: osVersionRaw(13, 0, 0, 2024, 11),
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-boot-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations.join(" ")).toContain("not decompressed");
  expect(snapshot.limitations.join(" ")).toContain("untrusted");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({ artifact_kind: "container" });
  expect(root?.format_metadata).toMatchObject({
    kind: "android-boot-image",
    image_kind: "boot",
    header_version: 0,
    os_version: "13.0.0",
    security_patch_level: "2024-11",
    command_line: "console=tty0 androidboot.hardware=test",
    component_count: 2,
    avb_footer_present: false,
    avb_footer_size: null,
  });
  const stored = await openAll(path);
  expect(stored.get("kernel")?.equals(kernel)).toBe(true);
  expect(stored.get("ramdisk")?.equals(ramdisk)).toBe(true);
  const carrier = await readFile(path);
  expect(carrier.subarray(2048, 2048 + kernel.length).equals(kernel)).toBe(
    true,
  );
});

it("extracts a v2 DTB, a v4 signature, and compressed ramdisks as stored", async () => {
  const dtb = Buffer.from("dtb-payload");
  const v2 = await writeCarrier(
    "v2.img",
    buildBootImage({
      version: 2,
      // A decodable ELF64 little-endian x86-64 header, as classification requires.
      kernel: elf(2, 1, 62),
      ramdisk: Buffer.alloc(0),
      dtb,
    }),
  );
  const v2Graph = await scanCanonicalArtifactInventory(v2);
  expect(
    v2Graph.occurrences.find((row) => row.logical_path === "kernel"),
  ).toMatchObject({ artifact_format: "elf" });
  expect(
    v2Graph.occurrences.find((row) => row.logical_path === "dtb"),
  ).toMatchObject({
    artifact_format: "file",
    source_location: { offset: 4096, length: dtb.length },
  });
  expect((await openAll(v2)).get("dtb")?.equals(dtb)).toBe(true);

  const signature = Buffer.from("boot-signature");
  const v4 = await writeCarrier(
    "v4.img",
    buildBootImage({
      version: 4,
      kernel: Buffer.from("kern"),
      ramdisk: Buffer.alloc(0),
      signature,
    }),
  );
  const v4Root = (await scanCanonicalArtifactInventory(v4)).occurrences.find(
    (row) => row.logical_path === ".",
  );
  expect(v4Root?.format_metadata).toMatchObject({
    header_version: 4,
    signature_size: signature.length,
    page_size: 4096,
  });
  expect((await openAll(v4)).get("signature")?.equals(signature)).toBe(true);

  const gzip = Buffer.from([0x1f, 0x8b, 0x08, 0]);
  const lz4 = Buffer.from([0x04, 0x22, 0x4d, 0x18, 1]);
  const zstd = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 2]);
  const compressed = await writeCarrier(
    "compressed.img",
    buildBootImage({ version: 0, kernel: lz4, ramdisk: gzip, second: zstd }),
  );
  const graph = await scanCanonicalArtifactInventory(compressed);
  expect(
    graph.occurrences.find((row) => row.logical_path === "ramdisk")
      ?.format_metadata,
  ).toMatchObject({ compression: "gzip" });
  expect(
    graph.occurrences.find((row) => row.logical_path === "kernel")
      ?.format_metadata,
  ).toMatchObject({ compression: "lz4" });
  expect(
    graph.occurrences.find((row) => row.logical_path === "second")
      ?.format_metadata,
  ).toMatchObject({ compression: "zstd" });
  const stored = await openAll(compressed);
  expect(stored.get("ramdisk")?.equals(gzip)).toBe(true);
  expect(stored.get("kernel")?.equals(lz4)).toBe(true);
  expect(stored.get("second")?.equals(zstd)).toBe(true);
  expect(
    graph.occurrences
      .find((row) => row.logical_path === "ramdisk")
      ?.limitations.join(" "),
  ).toContain("not decompressed");
});

it("extracts two vendor ramdisks without inventing fragment load addresses", async () => {
  const platform = Buffer.from("platform-bytes");
  const recovery = Buffer.from("recovery-bytes");
  const dtb = Buffer.from("vendor-dtb");
  const bootconfig = Buffer.from("androidboot.hardware=test\n");
  const path = await writeCarrier(
    "vendor_boot.img",
    buildVendorBootImage({
      version: 4,
      ramdisks: [
        { name: "platform", type: 1, bytes: platform },
        { name: "recovery", type: 2, bytes: recovery },
      ],
      dtb,
      bootconfig,
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    image_kind: "vendor-boot",
    vendor_ramdisk_table_entry_count: 2,
    component_count: 4,
    ramdisk_addr: 0x8100_0000,
  });
  const platformEntry = snapshot.occurrences.find(
    (row) => row.logical_path === "vendor_ramdisk/platform",
  );
  expect(platformEntry?.format_metadata).toMatchObject({
    role: "vendor-ramdisk",
    ramdisk_type: 1,
    ramdisk_type_name: "platform",
    load_address: null,
  });
  expect(
    snapshot.occurrences.find(
      (row) => row.logical_path === "vendor_ramdisk/recovery",
    )?.format_metadata,
  ).toMatchObject({ ramdisk_type_name: "recovery", load_address: null });
  expect(platformEntry?.source_location).toEqual({
    offset: 4096,
    length: platform.length,
  });
  const stored = await openAll(path);
  expect(stored.get("vendor_ramdisk/platform")?.equals(platform)).toBe(true);
  expect(stored.get("vendor_ramdisk/recovery")?.equals(recovery)).toBe(true);
  expect(stored.get("dtb")?.equals(dtb)).toBe(true);
  expect(stored.get("bootconfig")?.equals(bootconfig)).toBe(true);
});

it("keeps canonically equivalent ramdisk names distinct after normalization", async () => {
  const composed = "\u00e9";
  const decomposed = "e\u0301";
  const first = Buffer.from("composed-bytes");
  const second = Buffer.from("decomposed-bytes");
  const path = await writeCarrier(
    "vendor_boot.img",
    buildVendorBootImage({
      version: 4,
      ramdisks: [
        { name: composed, type: 1, bytes: first },
        { name: decomposed, type: 1, bytes: second },
      ],
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  const fragments = snapshot.occurrences.filter((row) =>
    row.logical_path.startsWith("vendor_ramdisk/"),
  );
  expect(fragments.map((row) => row.logical_path)).toEqual([
    `vendor_ramdisk/${composed}`,
    `vendor_ramdisk/${composed}-1`,
  ]);
  const hex = (name: string): string =>
    Buffer.concat([Buffer.from(name, "utf8"), Buffer.alloc(32)])
      .subarray(0, 32)
      .toString("hex");
  expect(
    fragments.map(
      (row) =>
        (row.format_metadata as { name_bytes_hex?: string }).name_bytes_hex,
    ),
  ).toEqual([hex(composed), hex(decomposed)]);
  const stored = await openAll(path);
  expect(stored.get(`vendor_ramdisk/${composed}`)?.equals(first)).toBe(true);
  expect(stored.get(`vendor_ramdisk/${composed}-1`)?.equals(second)).toBe(true);
});

it("records an AVB footer without treating it as a child", async () => {
  const image = buildBootImage({ version: 3, cmdline: "console=tty0" });
  const path = await writeCarrier("avb.img", appendAvbFooter(image));
  const root = (await scanCanonicalArtifactInventory(path)).occurrences.find(
    (row) => row.logical_path === ".",
  );
  expect(root?.format_metadata).toMatchObject({
    avb_footer_present: true,
    avb_footer_size: 64,
    avb_version_major: 1,
    avb_original_image_size: image.length,
    avb_vbmeta_offset: image.length,
    command_line: "console=tty0",
  });
  const paths = (await openAll(path)).keys();
  expect([...paths]).not.toContain("vbmeta");
  const unrecognized = await writeCarrier(
    "trailing.img",
    Buffer.concat([image, Buffer.alloc(64)]),
  );
  const trailing = (
    await scanCanonicalArtifactInventory(unrecognized)
  ).occurrences.find((row) => row.logical_path === ".");
  expect(trailing?.format_metadata).toMatchObject({
    avb_footer_present: false,
    avb_footer_size: null,
  });
});

it("inventories an image whose final page padding is absent", async () => {
  const kernel = Buffer.from("kernel-bytes");
  const ramdisk = Buffer.from("ramdisk-bytes");
  const padded = buildBootImage({ version: 0, kernel, ramdisk });
  // The ramdisk starts on page 2; drop only the zero padding after it.
  const unpadded = padded.subarray(0, 4096 + ramdisk.length);
  expect(padded.subarray(unpadded.length).every((byte) => byte === 0)).toBe(
    true,
  );
  const path = await writeCarrier("unpadded.img", unpadded);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.coverage.status).toBe("complete");
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    component_count: 2,
    avb_footer_present: false,
    avb_footer_size: null,
  });
  const stored = await openAll(path);
  expect(stored.get("kernel")?.equals(kernel)).toBe(true);
  expect(stored.get("ramdisk")?.equals(ramdisk)).toBe(true);
});

it("fails closed on truncation and overlapping ranges", async () => {
  const truncated = await writeCarrier(
    "truncated.img",
    truncateImage(buildBootImage({ version: 0 })),
  );
  await expect(scanCanonicalArtifactInventory(truncated)).rejects.toThrow(
    /truncated/u,
  );
  const overlap = await writeCarrier(
    "overlap.img",
    buildBootImage({
      version: 2,
      recoveryDtbo: Buffer.from("dtbo"),
      recoveryDtboOffset: 2048,
      dtb: Buffer.from("dtb"),
    }),
  );
  await expect(scanCanonicalArtifactInventory(overlap)).rejects.toThrow(
    /overlaps an earlier component/u,
  );
  const vendor = buildVendorBootImage({
    version: 4,
    ramdisks: [
      { name: "one", type: 1, bytes: Buffer.from("aaa") },
      { name: "two", type: 1, bytes: Buffer.from("bbbbb") },
    ],
  });
  const overlapped = Buffer.from(vendor);
  const entrySize = overlapped.readUInt32LE(2120);
  overlapped.writeUInt32LE(0, 8192 + entrySize + 4);
  await expect(
    scanCanonicalArtifactInventory(
      await writeCarrier("vendor-overlap.img", overlapped),
    ),
  ).rejects.toThrow(/overlaps entry/u);
});

it("finds an AVB footer before the final boot page boundary", async () => {
  const pageSize = 32 * 1024;
  const kernel = Buffer.alloc(64, 0x4b);
  const padded = buildBootImage({
    version: 0,
    pageSize,
    kernel,
    ramdisk: Buffer.alloc(0),
  });
  const unpadded = padded.subarray(0, pageSize + kernel.length);
  // avbtool append_vbmeta_image uses 4 KiB blocks independently of boot pages.
  const path = await writeCarrier(
    "early-footer.img",
    appendAvbFooter(unpadded, {
      vbmeta: Buffer.alloc(256),
      vbmetaOffset: 36 * 1024,
      partitionSize: 44 * 1024,
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    avb_footer_present: true,
    avb_original_image_size: unpadded.length,
    avb_vbmeta_offset: 36 * 1024,
    avb_vbmeta_size: 256,
  });
});

it.each([1, 32])(
  "refuses vbmeta starting at original image end minus %i",
  async (overlap) => {
    const image = buildBootImage({
      version: 0,
      kernel: Buffer.alloc(64),
      ramdisk: Buffer.alloc(0),
    });
    const bytes = appendAvbFooter(image, {
      vbmeta: Buffer.alloc(16),
      vbmetaOffset: image.length - overlap,
    });
    const path = await writeCarrier("overlapping-original-image.img", bytes);
    await expect(scanCanonicalArtifactInventory(path)).rejects.toThrow(
      /AVB vbmeta overlaps the original boot image/u,
    );
  },
);

it("retains boot components with unknown coverage when optional trailing AVB footer parsing fails", async () => {
  const kernel = Buffer.from("kernel-bytes");
  const image = buildBootImage({
    version: 0,
    kernel,
    ramdisk: Buffer.alloc(0),
  });
  // Append an AVB footer whose original_image_size is smaller than dataEnd (non-overlap parse failure).
  const badFooter = Buffer.alloc(64);
  badFooter.write("AVBf", 0, "ascii");
  badFooter.writeUInt32BE(1, 4);
  badFooter.writeBigUInt64BE(16n, 12);
  const path = await writeCarrier(
    "bad-avb-footer.img",
    Buffer.concat([image, badFooter]),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-boot-image");
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join(" ")).toContain(
    "Optional trailing AVB footer could not be parsed",
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "android-boot-image",
    avb_footer_present: false,
    component_count: 1,
  });
  expect((await openAll(path)).get("kernel")?.equals(kernel)).toBe(true);
});

it("retains header metadata and other components when vendor ramdisk table parsing fails without overlap", async () => {
  const dtb = Buffer.from("vendor-dtb");
  const bootconfig = Buffer.from("androidboot.hardware=test\n");
  const vendor = buildVendorBootImage({
    version: 4,
    ramdisks: [{ name: "platform", type: 1, bytes: Buffer.from("platform") }],
    dtb,
    bootconfig,
  });
  const corrupted = Buffer.from(vendor);
  // Header page (4096) + ramdisk page (4096) + dtb page (4096) = table at 12288.
  // Corrupt entry 0's size so it overruns vendorRamdiskSize (non-overlap failure).
  corrupted.writeUInt32LE(0x10_0000, 12288);
  const path = await writeCarrier("bad-vendor-table.img", corrupted);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-boot-image");
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join(" ")).toContain(
    "Vendor ramdisk table could not be parsed",
  );
  expect(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => row.logical_path)
      .sort(),
  ).toEqual(["bootconfig", "dtb"]);
  const stored = await openAll(path);
  expect(stored.get("dtb")?.equals(dtb)).toBe(true);
  expect(stored.get("bootconfig")?.equals(bootconfig)).toBe(true);
});

it.each([
  {
    name: "a vendor ramdisk section without table entries",
    image: () =>
      buildVendorBootImage({
        version: 4,
        section: Buffer.from("uncovered-section"),
      }),
    children: [],
    limitation: "outside the ramdisk table were not exposed",
  },
  {
    name: "table entries that cover part of the vendor ramdisk section",
    image: () =>
      buildVendorBootImage({
        version: 4,
        ramdisks: [{ name: "one", bytes: Buffer.from("ramdisk-one") }],
        section: Buffer.from("ramdisk-onetail-bytes"),
      }),
    children: ["vendor_ramdisk/one"],
    limitation: "outside the ramdisk table were not exposed",
  },
  {
    name: "bytes between the sequential layout and recovery_dtbo",
    image: () =>
      buildBootImage({
        version: 1,
        kernel: Buffer.from("kernel"),
        ramdisk: Buffer.alloc(0),
        recoveryDtbo: Buffer.from("dtbo"),
        recoveryDtboOffset: 4096 * 5,
      }),
    children: ["kernel", "recovery_dtbo"],
    limitation: "Bytes between the sequential layout and recovery_dtbo",
  },
])(
  "keeps coverage unknown for $name",
  async ({ image, children, limitation }) => {
    const path = await writeCarrier("unexposed.img", image());
    const snapshot = await scanCanonicalArtifactInventory(path);
    expect(snapshot.coverage.status).toBe("unknown");
    expect(snapshot.limitations.join(" ")).toContain(limitation);
    expect(
      snapshot.occurrences
        .filter((row) => row.logical_path !== ".")
        .map((row) => row.logical_path)
        .sort(),
    ).toEqual(children);
  },
);

it("refuses an AVB footer whose vbmeta overlaps the boot header even when original_image_size is also invalid", async () => {
  const image = buildBootImage({
    version: 0,
    kernel: Buffer.from("kernel-bytes"),
    ramdisk: Buffer.alloc(0),
  });
  const badFooter = Buffer.alloc(64);
  badFooter.write("AVBf", 0, "ascii");
  badFooter.writeUInt32BE(1, 4);
  // Both faults present: original_image_size < dataEnd AND vbmeta overlaps header at offset 0.
  badFooter.writeBigUInt64BE(16n, 12);
  badFooter.writeBigUInt64BE(0n, 20);
  badFooter.writeBigUInt64BE(16n, 28);
  const path = await writeCarrier(
    "bad-avb-footer-overlap.img",
    Buffer.concat([image, badFooter]),
  );
  await expect(scanCanonicalArtifactInventory(path)).rejects.toThrow(
    /AVB vbmeta overlaps the boot image header/u,
  );
});

it("refuses a vendor ramdisk table with overlapping entries even when an entry also overruns the section", async () => {
  const vendor = buildVendorBootImage({
    version: 4,
    ramdisks: [
      { name: "one", type: 1, bytes: Buffer.from("aaa") },
      { name: "two", type: 1, bytes: Buffer.from("bbbbb") },
    ],
  });
  const corrupted = Buffer.from(vendor);
  const entrySize = corrupted.readUInt32LE(2120);
  // Entry 0 overruns vendorRamdiskSize AND entry 1 overlaps entry 0 at offset 0.
  corrupted.writeUInt32LE(0x10_0000, 8192);
  corrupted.writeUInt32LE(0, 8192 + entrySize + 4);
  const path = await writeCarrier("vendor-overrun-and-overlap.img", corrupted);
  await expect(scanCanonicalArtifactInventory(path)).rejects.toThrow(
    /overlaps entry/u,
  );
});
