import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

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
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-android-boot-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

const openAll = async (path: string): Promise<ReadonlyMap<string, Buffer>> => {
  const reader = new AndroidBootImageArtifactReader(path);
  const out = new Map<string, Buffer>();
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    for (const entry of entries)
      out.set(entry.path, await collect(await reader.open(entry)));
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
      kernel: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
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

it("extracts two vendor ramdisks, the DTB, and bootconfig", async () => {
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
  });
  const platformEntry = snapshot.occurrences.find(
    (row) => row.logical_path === "vendor_ramdisk/platform",
  );
  expect(platformEntry?.format_metadata).toMatchObject({
    role: "vendor-ramdisk",
    ramdisk_type: 1,
    ramdisk_type_name: "platform",
    load_address: 0x8100_0000,
  });
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
