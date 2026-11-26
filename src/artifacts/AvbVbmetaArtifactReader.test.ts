import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, it } from "vitest";

import { AvbVbmetaArtifactReader } from "./AvbVbmetaArtifactReader.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  buildVbmetaImage,
  buildVbmetaImageWithAllDescriptors,
  chainPartitionDescriptor,
  encodeDescriptor,
  hashDescriptor,
  hashtreeDescriptor,
  kernelCmdlineDescriptor,
  propertyDescriptor,
} from "../../tests/fixtures/avbVbmeta.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-avb-vbmeta-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

const openAll = async (path: string): Promise<ReadonlyMap<string, Buffer>> => {
  const reader = new AvbVbmetaArtifactReader(path);
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

const allDescriptors = [
  propertyDescriptor("com.android.build.fingerprint", "test-fingerprint"),
  hashtreeDescriptor({}),
  hashDescriptor({}),
  kernelCmdlineDescriptor("androidboot.veritymode=enforcing"),
  chainPartitionDescriptor({}),
];

it("classifies vbmeta bytes by content, not by suffix", () => {
  expect(
    classifyArtifactBytesAtPath(
      "notes.txt",
      buildVbmetaImageWithAllDescriptors(),
    ),
  ).toEqual({ kind: "container", format: "avb-vbmeta-image" });
  expect(
    classifyArtifactBytesAtPath("vbmeta.img", Buffer.from("nope")),
  ).toEqual({ kind: "resource", format: "file" });
});

it("inventories and extracts every descriptor", async () => {
  const path = await writeCarrier(
    "vbmeta.img",
    buildVbmetaImageWithAllDescriptors(),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("avb-vbmeta-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations.join(" ")).toContain("not verified");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({ artifact_kind: "container" });
  expect(root?.format_metadata).toMatchObject({
    kind: "avb-vbmeta-image",
    required_libavb_version_major: 1,
    required_libavb_version_minor: 2,
    algorithm_type: 1,
    algorithm_type_name: "sha256-rsa2048",
    rollback_index: "7",
    rollback_index_location: 2,
    release_string: "avbtool 1.2.0",
    descriptor_count: 5,
  });
  const metadata = root?.format_metadata as
    | { readonly descriptors?: readonly { readonly kind?: string }[] }
    | undefined;
  expect(metadata?.descriptors?.map((item) => item.kind)).toEqual([
    "property",
    "hashtree",
    "hash",
    "kernel-cmdline",
    "chain-partition",
  ]);
  const stored = await openAll(path);
  expect([...stored.keys()]).toEqual([
    "descriptor-0-property.bin",
    "descriptor-1-hashtree.bin",
    "descriptor-2-hash.bin",
    "descriptor-3-kernel-cmdline.bin",
    "descriptor-4-chain-partition.bin",
  ]);
  for (const [index, descriptor] of allDescriptors.entries()) {
    const name = [
      "descriptor-0-property.bin",
      "descriptor-1-hashtree.bin",
      "descriptor-2-hash.bin",
      "descriptor-3-kernel-cmdline.bin",
      "descriptor-4-chain-partition.bin",
    ][index]!;
    expect(stored.get(name)?.equals(encodeDescriptor(descriptor))).toBe(true);
  }
});

it("inventories a vbmeta image with a trailing AVBf footer", async () => {
  const image = buildVbmetaImageWithAllDescriptors();
  const footer = Buffer.alloc(64);
  footer.write("AVBf", 0, "ascii");
  const path = await writeCarrier("vbmeta.img", Buffer.concat([image, footer]));
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("avb-vbmeta-image");
  expect(snapshot.limitations.join(" ")).toContain("AVBf footer");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    kind: "avb-vbmeta-image",
    trailing_bytes: 64,
    descriptor_count: 5,
  });
});

it("rejects a file without the AVB0 magic", async () => {
  const path = await writeCarrier(
    "vbmeta.img",
    Buffer.from("AVB1" + "x".repeat(300)),
  );
  const reader = new AvbVbmetaArtifactReader(path);
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries()) {
          // Entries are never yielded for a rejected image.
        }
      })(),
    ).rejects.toThrow(/magic is not AVB0/u);
  } finally {
    await reader.close();
  }
});

it("rejects a truncated vbmeta image", async () => {
  const image = buildVbmetaImageWithAllDescriptors();
  const path = await writeCarrier(
    "vbmeta.img",
    image.subarray(0, image.length - 64),
  );
  const reader = new AvbVbmetaArtifactReader(path);
  try {
    await expect(
      (async () => {
        for await (const _entry of reader.entries()) {
          // Entries are never yielded for a rejected image.
        }
      })(),
    ).rejects.toThrow(/truncated/u);
  } finally {
    await reader.close();
  }
});

it("exposes an empty descriptor table as a descriptor-less image", async () => {
  const path = await writeCarrier(
    "vbmeta.img",
    buildVbmetaImage({ releaseString: "avbtool 1.2.0" }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("avb-vbmeta-image");
  expect(snapshot.coverage.status).toBe("complete");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    kind: "avb-vbmeta-image",
    descriptor_count: 0,
  });
  expect(await openAll(path)).toHaveLength(0);
});
