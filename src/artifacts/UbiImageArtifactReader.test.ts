import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { expect, it } from "vitest";

import { UbiImageArtifactReader } from "./UbiImageArtifactReader.js";
import { ArtifactEntryContentUnavailable } from "../resources/ArtifactReader.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import {
  twoVolumeUbiImage,
  ubiImage,
  ubiLayoutPebs,
  ubiLebData,
  UBI_FIXTURE_KERNEL,
  type UbiFixtureVolumeRecord,
} from "../domain/firmware/ubiImage.fixture.js";
import { UBI_IMAGE_LIMITATIONS } from "../domain/firmware/ubiImage.js";
import { zipArchive } from "../domain/desktop/zipArchive.fixture.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const path = join(await createTestTempDirectory("rea-ubi-image-"), name);
  await writeFile(path, bytes);
  return path;
};

const ROOTFS = Buffer.concat([
  ubiLebData(0x72, "ROOTFS-0"),
  ubiLebData(0x52, "ROOTFS-1"),
]);

const missingLebImage = (): Buffer => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 4 },
    { id: 1, name: "config", type: "dynamic", reservedPebs: 1 },
  ];
  return ubiImage([
    ...ubiLayoutPebs(records),
    { kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x30), sqnum: 2n },
    { kind: "leb", volId: 0, lnum: 2, data: ubiLebData(0x32), sqnum: 3n },
    {
      kind: "leb",
      volId: 1,
      lnum: 0,
      data: ubiLebData(0x43, "CONFIG"),
      sqnum: 4n,
    },
  ]);
};

it("classifies UBI images as containers by UBI# magic, not by suffix", async () => {
  const bytes = twoVolumeUbiImage();
  expect(classifyArtifactBytesAtPath("flash.bin", bytes)).toEqual({
    kind: "container",
    format: "ubi-image",
  });
  const badCrc = Buffer.from(bytes);
  badCrc.writeUInt32BE(0, 60);
  expect(classifyArtifactBytesAtPath("rootfs.ubi", badCrc)).toEqual({
    kind: "resource",
    format: "file",
  });
  const archive = zipArchive([{ name: "rootfs.ubi", data: bytes, method: 0 }]);
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("firmware.zip", archive),
  );
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "rootfs.ubi"),
  ).toMatchObject({
    artifact_format: "ubi-image",
    artifact_kind: "container",
  });
});

it("inventories the volume table and reassembled volumes", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("nand.ubi", twoVolumeUbiImage()),
  );
  expect(snapshot.manifest.root_format).toBe("ubi-image");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations).toContain(UBI_IMAGE_LIMITATIONS.inventoryScope);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "ubi-image",
    magic: "UBI#",
    peb_size: 2048,
    leb_size: 1920,
    vid_header_offset: 64,
    data_offset: 128,
    image_seq: 0x1234_5678,
    peb_count: 9,
    free_peb_count: 1,
    erased_peb_count: 1,
    stale_leb_copy_count: 1,
    volume_table_copies_agree: true,
    data_crc_verified: false,
    volumes: [
      {
        id: 0,
        name: "kernel",
        name_bytes_hex: null,
        path: "volumes/kernel",
        type: "static",
      },
      { id: 1, name: "rootfs", path: "volumes/rootfs", autoresize: true },
    ],
  });
  const members = snapshot.occurrences.filter(
    (row) => row.logical_path !== ".",
  );
  const sha256 = (artifactId: string | null) =>
    snapshot.nodes.find((node) => node.artifact_id === artifactId)?.sha256;
  expect(
    members.map((row) => [row.logical_path, sha256(row.artifact_id)]),
  ).toEqual([
    [
      "volumes/kernel",
      createHash("sha256").update(UBI_FIXTURE_KERNEL).digest("hex"),
    ],
    ["volumes/rootfs", createHash("sha256").update(ROOTFS).digest("hex")],
  ]);
  expect(members[0]?.format_metadata).toMatchObject({
    kind: "ubi-volume",
    used_ebs: 2,
    data_bytes: UBI_FIXTURE_KERNEL.length,
    extractable: true,
  });
});

it("extracts each volume from its logical eraseblocks in order", async () => {
  const path = await writeCarrier("nand.ubi", twoVolumeUbiImage());
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "ubi-image",
      outputRoot: join(path, "..", "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.containment_verified).toBe(true);
    expect(
      (await readFile(join(extracted.output_root, "volumes/kernel"))).equals(
        UBI_FIXTURE_KERNEL,
      ),
    ).toBe(true);
    expect(
      (await readFile(join(extracted.output_root, "volumes/rootfs"))).equals(
        ROOTFS,
      ),
    ).toBe(true);
  } finally {
    await resourceScope.close();
  }
});

it("refuses a volume with a missing LEB while serving the others", async () => {
  const path = await writeCarrier("gap.ubi", missingLebImage());
  const reader = new UbiImageArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const [rootfs, config] = entries;
    expect(rootfs).toMatchObject({
      path: "volumes/rootfs",
      declaredSize: null,
      limitations: [UBI_IMAGE_LIMITATIONS.missingLebs],
      formatMetadata: {
        kind: "ubi-volume",
        missing_leb_count: 1,
        first_missing_leb: 1,
        extractable: false,
      },
    });
    await expect(reader.open(rootfs!)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
    const bytes = await buffer(await reader.open(config!));
    expect(bytes.subarray(0, 6).toString("latin1")).toBe("CONFIG");
    expect(bytes.length).toBe(1920);
  } finally {
    await reader.close();
  }
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "volumes/rootfs")
      ?.hash_status,
  ).toBe("unavailable");
  const resourceScope = new ArtifactResourceScope();
  try {
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "ubi-image",
        outputRoot: join(path, "..", "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toMatchObject({
      reason: "unavailable",
      message: expect.stringContaining("volumes/rootfs"),
    });
  } finally {
    await resourceScope.close();
  }
});

it("serves the older LEB copy when a newer wear-leveling copy fails its data CRC", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 },
  ];
  const path = await writeCarrier(
    "copy.ubi",
    ubiImage([
      ...ubiLayoutPebs(records),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x30, "ORIGINAL"),
        sqnum: 2n,
      },
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x31, "TORN"),
        sqnum: 3n,
        copyFlag: true,
        dataCrc: 0,
      },
    ]),
  );
  const reader = new UbiImageArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const bytes = await buffer(await reader.open(entries[0]!));
    expect(bytes.subarray(0, 8).toString("latin1")).toBe("ORIGINAL");
    expect(reader.formatMetadata()).toMatchObject({ stale_leb_copy_count: 1 });
  } finally {
    await reader.close();
  }
});

it("keeps the LEB mapping private to the reader", async () => {
  const path = await writeCarrier("nand.ubi", twoVolumeUbiImage());
  const reader = new UbiImageArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const kernel = entries.find((entry) => entry.path === "volumes/kernel");
    expect(kernel).toBeDefined();
    expect(kernel).not.toHaveProperty("volume");
    // Rewriting what a caller can reach does not move the bytes open() reads.
    Object.assign(kernel!, { volume: { ranges: [] } });
    const bytes = await buffer(await reader.open(kernel!));
    expect(bytes.equals(UBI_FIXTURE_KERNEL)).toBe(true);
  } finally {
    await reader.close();
  }
});
