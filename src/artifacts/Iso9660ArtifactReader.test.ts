import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, it } from "vitest";

import { Iso9660ArtifactReader } from "./Iso9660ArtifactReader.js";
import { classifyArtifactContent } from "./inventory/ArtifactGraphConstruction.js";
import { createArtifactClassificationProbe } from "./ArtifactClassificationProbe.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { pe } from "../domain/binaryTarget.fixture.js";
import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import {
  buildFfsFile,
  buildFv,
  buildImage,
} from "../../tests/fixtures/uefiImage.js";
import {
  buildIso9660Image,
  type Iso9660FixtureFile,
} from "../domain/iso9660/iso9660.fixture.js";

const SECTOR = 2048;
const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const path = join(await createTestTempDirectory("rea-iso9660-"), name);
  await writeFile(path, bytes);
  return path;
};

const setup = pe(0x14c);
const files: readonly Iso9660FixtureFile[] = [
  { path: "README.TXT", bytes: Buffer.from("installer readme\n") },
  {
    path: "bin/setup.exe",
    bytes: setup,
    primaryIdentifier: "SETUP.EXE;1",
  },
  {
    path: "bin/data/payload.bin",
    bytes: Buffer.alloc(3 * SECTOR + 17, 0x5a),
  },
];

const listing = async (path: string) => {
  const reader = new Iso9660ArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const contents = new Map<string, Buffer>();
    for (const entry of entries)
      if (entry.kind === "file")
        contents.set(entry.path, await collect(await reader.open(entry)));
    return { entries, contents, metadata: reader.formatMetadata() };
  } finally {
    await reader.close();
  }
};

it("classifies an image by its sector 16 descriptor, not its name, when streamed", () => {
  const { bytes } = buildIso9660Image({ files });
  const probe = createArtifactClassificationProbe();
  for (let offset = 0; offset < bytes.length; offset += 4096)
    probe.write(bytes.subarray(offset, offset + 4096));
  expect(
    classifyArtifactContent(
      "media/disk.bin",
      probe.finish(bytes.length),
      bytes.length,
    ),
  ).toMatchObject({ kind: "container", format: "iso9660" });
});

it("lists the same tree from primary and Joliet names, with Joliet spellings winning", async () => {
  const primary = await listing(
    await writeCarrier("primary.iso", buildIso9660Image({ files }).bytes),
  );
  const joliet = await listing(
    await writeCarrier(
      "joliet.iso",
      buildIso9660Image({ files, joliet: true }).bytes,
    ),
  );
  const shape = (rows: typeof primary.entries) =>
    rows.map(({ path, kind, declaredSize }) => ({ path, kind, declaredSize }));
  // Each directory's members are listed when it is read, depth first.
  expect(shape(joliet.entries)).toEqual([
    { path: "bin", kind: "directory", declaredSize: SECTOR },
    { path: "README.TXT", kind: "file", declaredSize: 17 },
    { path: "bin/data", kind: "directory", declaredSize: SECTOR },
    { path: "bin/setup.exe", kind: "file", declaredSize: setup.length },
    {
      path: "bin/data/payload.bin",
      kind: "file",
      declaredSize: 3 * SECTOR + 17,
    },
  ]);
  // The primary tree spells the executable in its own d-characters.
  expect(shape(primary.entries)).toEqual(
    shape(joliet.entries).map((row) =>
      row.path === "bin/setup.exe" ? { ...row, path: "bin/SETUP.EXE" } : row,
    ),
  );
  expect(joliet.metadata).toMatchObject({
    kind: "iso9660",
    name_source: "joliet",
    joliet_level: 3,
    directory_count: 2,
    file_count: 3,
  });
  expect(primary.metadata).toMatchObject({
    name_source: "primary",
    joliet_level: null,
  });
  for (const file of files)
    expect(sha256(joliet.contents.get(file.path)!), file.path).toBe(
      sha256(file.bytes),
    );
  expect(
    joliet.entries.find(({ path }) => path === "bin/setup.exe")?.sourcePath,
  ).toBe("bin/setup.exe;1");
});

it("inventories volume facts and classifies an extracted executable child", async () => {
  const path = await writeCarrier(
    "installer.iso",
    buildIso9660Image({ files, joliet: true, elTorito: true }).bytes,
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("iso9660");
  // Only the Joliet tree is walked; the primary tree may list other files.
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join(" ")).toContain(
    "The primary directory tree (root extent at block",
  );
  expect(snapshot.limitations.join(" ")).toContain("Rock Ridge");
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({
    kind: "iso9660",
    volume_identifier: "REA_TEST",
    logical_block_size: 2048,
    el_torito_boot_record: true,
    creation_date: "2024-01-02T03:04:05.00+01:00",
  });
  const exe = snapshot.occurrences.find(
    (row) => row.logical_path === "bin/setup.exe",
  );
  expect(exe).toMatchObject({
    artifact_format: "pe",
    hash_status: "verified",
    source_path: "bin/setup.exe;1",
    format_metadata: { kind: "iso9660-entry", extent_layout: "contiguous" },
  });
  expect(
    snapshot.nodes.find((node) => node.artifact_id === exe?.artifact_id)
      ?.sha256,
  ).toBe(sha256(setup));
});

it("lists an empty file whose extent is the unallocated sentinel", async () => {
  for (const joliet of [false, true]) {
    const { bytes, layout } = buildIso9660Image({
      files: [
        { path: "empty.txt", bytes: Buffer.alloc(0) },
        { path: "full.txt", bytes: Buffer.from("full") },
      ],
      joliet,
    });
    for (const records of [layout.primaryRecords, layout.jolietRecords]) {
      const record = records.get("empty.txt");
      if (record === undefined) continue;
      bytes.writeUInt32LE(0xfffffff0, record + 2);
      bytes.writeUInt32BE(0xfffffff0, record + 6);
    }
    const snapshot = await scanCanonicalArtifactInventory(
      await writeCarrier("empty.iso", bytes),
    );
    expect(snapshot.manifest.root_format).toBe("iso9660");
    const empty = snapshot.occurrences.find(
      (row) => row.logical_path === "empty.txt",
    );
    expect(empty).toMatchObject({ declared_size: 0, hash_status: "verified" });
    expect(JSON.stringify(empty)).toContain("unallocated extent sentinel");
    const full = snapshot.occurrences.find(
      (row) => row.logical_path === "full.txt",
    );
    expect(full).toMatchObject({ hash_status: "verified" });
  }
});

it("concatenates contiguous extents and refuses separated or interleaved ones", async () => {
  const big = Buffer.concat([Buffer.alloc(SECTOR, 1), Buffer.alloc(9, 2)]);
  const path = await writeCarrier(
    "extents.iso",
    buildIso9660Image({
      files: [
        { path: "big.bin", bytes: big, extents: [SECTOR, 9] },
        {
          path: "split.bin",
          bytes: big,
          extents: [SECTOR, 9],
          fragmented: true,
        },
        { path: "units.bin", bytes: Buffer.from("units"), interleaved: true },
      ],
    }).bytes,
  );
  const reader = new Iso9660ArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(
      (await collect(await reader.open(byPath.get("big.bin")!))).equals(big),
    ).toBe(true);
    // Flags are observed in the first record, which continues the file.
    expect(byPath.get("big.bin")?.formatMetadata).toMatchObject({
      extent_count: 2,
      extent_layout: "contiguous",
      file_flags: 0x80,
    });
    for (const [name, layout] of [
      ["split.bin", "fragmented"],
      ["units.bin", "interleaved"],
    ] as const) {
      const entry = byPath.get(name)!;
      expect(entry.formatMetadata).toMatchObject({ extent_layout: layout });
      expect(entry.limitations.join(" ")).toContain(
        layout === "interleaved"
          ? "interleaved"
          : "source_location covers only its first extent",
      );
      await expect(
        reader.open({ ...entry, adapterKey: "foreign" }),
      ).rejects.toMatchObject({
        reason: "integrity",
        integrityCheck: "foreign-entry",
      });
      await expect(
        reader.open({
          ...byPath.get("big.bin")!,
          formatMetadata: entry.formatMetadata!,
        }),
      ).rejects.toMatchObject({
        reason: "integrity",
        integrityCheck: "entry-metadata",
      });
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "unavailable",
        limitation: entry.limitations[0],
      });
    }
    // A changed carrier is reported as changed, for an unreadable layout as
    // for its readable sibling, not refused from the cached layout.
    await appendFile(path, Buffer.alloc(SECTOR));
    for (const name of ["big.bin", "split.bin", "units.bin"])
      await expect(reader.open(byPath.get(name)!), name).rejects.toMatchObject({
        reason: "integrity",
        integrityCheck: "container-identity",
      });
  } finally {
    await reader.close();
  }
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "units.bin"),
  ).toMatchObject({ hash_status: "unavailable" });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "big.bin"),
  ).toMatchObject({ hash_status: "verified" });
});

it("serves the first section's own carrier range when a later section is interleaved", async () => {
  const head = Buffer.alloc(SECTOR, 3);
  const { bytes, layout } = buildIso9660Image({
    files: [
      {
        path: "mixed.bin",
        bytes: Buffer.concat([head, Buffer.from("tail")]),
        extents: [SECTOR, 4],
      },
    ],
  });
  const first = layout.primaryRecords.get("mixed.bin")!;
  const second = first + bytes[first]!;
  bytes[second + 26] = 1;
  bytes[second + 27] = 1;
  const reader = new Iso9660ArtifactReader(
    await writeCarrier("mixed.iso", bytes),
  );
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries.find(({ path }) => path === "mixed.bin")!;
    expect(entry).toMatchObject({
      byteOffset: layout.fileOffsets.get("mixed.bin"),
      byteLength: SECTOR,
      formatMetadata: { extent_count: 2, extent_layout: "interleaved" },
    });
    expect(entry.limitations[0]).toContain("interleaved");
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "unavailable",
    });
  } finally {
    await reader.close();
  }
});

it("charges the plaintext budget only for files it can read", async () => {
  // 800 one-block sections, each rewritten to declare the whole 800-block
  // run: about 1.3 GB declared by a separated file in a ~1.7 MB image.
  const sections = 800;
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "keep.txt", bytes: Buffer.from("keep") },
      {
        path: "alias.bin",
        bytes: Buffer.alloc(sections * SECTOR),
        extents: Array.from({ length: sections }, () => SECTOR),
      },
    ],
  });
  const first = layout.primaryRecords.get("alias.bin")!;
  const location = bytes.readUInt32LE(first + 2);
  const identifier = bytes.subarray(
    first + 33,
    first + 33 + bytes[first + 32]!,
  );
  let at = first;
  for (let rewritten = 0; rewritten < sections;) {
    if (bytes[at] === 0) {
      at = (Math.floor(at / SECTOR) + 1) * SECTOR;
      continue;
    }
    if (bytes.subarray(at + 33, at + 33 + bytes[at + 32]!).equals(identifier)) {
      bytes.writeUInt32LE(location, at + 2);
      bytes.writeUInt32BE(location, at + 6);
      bytes.writeUInt32LE(sections * SECTOR, at + 10);
      bytes.writeUInt32BE(sections * SECTOR, at + 14);
      rewritten += 1;
    }
    at += bytes[at]!;
  }
  const reader = new Iso9660ArtifactReader(
    await writeCarrier("alias.iso", bytes),
  );
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    expect(byPath.get("alias.bin")?.formatMetadata).toMatchObject({
      extent_layout: "fragmented",
      extent_count: sections,
    });
    const keep = await collect(await reader.open(byPath.get("keep.txt")!));
    expect(keep.toString()).toBe("keep");
  } finally {
    await reader.close();
  }
});

it("renames unsafe identifiers and keeps the stored identifier as source_path", async () => {
  const path = await writeCarrier(
    "unsafe.iso",
    buildIso9660Image({
      files: [
        { path: "a.txt", bytes: Buffer.from("1") },
        { path: "b.txt", bytes: Buffer.from("2"), primaryIdentifier: "..;1" },
        {
          path: "c.txt",
          bytes: Buffer.from("3"),
          primaryIdentifier: "a.txt;1",
        },
      ],
    }).bytes,
  );
  const { entries } = await listing(path);
  expect(
    entries.map(({ path: logical, sourcePath }) => ({ logical, sourcePath })),
  ).toEqual([
    { logical: "a.txt", sourcePath: "a.txt;1" },
    { logical: "entry-1", sourcePath: "..;1" },
    { logical: "a.txt-2", sourcePath: "a.txt;1" },
  ]);
  expect(entries[1]?.limitations.join(" ")).toContain("entry-1");
});

it("lists a primary identifier with bytes above 0x7F with an undeclared-charset limitation", async () => {
  const { entries } = await listing(
    await writeCarrier(
      "latin.iso",
      buildIso9660Image({
        files: [
          { path: "plain.txt", bytes: Buffer.from("p") },
          {
            path: "cafe.txt",
            bytes: Buffer.from("c"),
            primaryIdentifier: "CAF\u00c9.TXT;1",
          },
        ],
      }).bytes,
    ),
  );
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  expect(byPath.get("CAF\u00c9.TXT")?.limitations).toEqual([
    "ISO 9660 primary identifier has bytes above 0x7F, which ECMA-119 does not assign; they are shown as Latin-1 and the intended characters are unknown.",
  ]);
  expect(byPath.get("plain.txt")?.limitations).toEqual([]);
});

it("keeps the ISO tree when a file inside the first MiB is a UEFI firmware volume", async () => {
  // File extents are sector-aligned, so a whole aligned FFS2 volume sits in
  // the first MiB where the whole-file UEFI probe would otherwise admit it.
  const firmware = buildImage({
    volumes: [
      buildFv({
        files: [
          buildFfsFile({
            guid: "9e21fd93-9c72-4c15-8c4b-e77f9db8d4d2",
            typeCode: 0x07,
            payload: Buffer.from("driver bytes", "ascii"),
          }),
        ],
      }).buffer,
    ],
  });
  const { bytes, layout } = buildIso9660Image({
    files: [
      { path: "README.TXT", bytes: Buffer.from("media\n") },
      { path: "firmware/bios.fd", bytes: firmware },
    ],
  });
  expect(layout.fileOffsets.get("firmware/bios.fd")).toBeLessThan(1 << 20);
  const path = await writeCarrier("media.bin", bytes);

  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("iso9660");
  const paths = snapshot.occurrences.map((row) => row.logical_path);
  expect(paths).toEqual(
    expect.arrayContaining([".", "README.TXT", "firmware/bios.fd"]),
  );
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  const child = snapshot.occurrences.find(
    (row) => row.logical_path === "firmware/bios.fd",
  );
  // Nested bytes are not whole-file firmware probed; the volume stays a
  // member whose exact bytes can be extracted and inspected as a root.
  expect(child).toMatchObject({ entry_kind: "file", hash_status: "verified" });
  expect(
    snapshot.nodes.find((node) => node.artifact_id === child?.artifact_id)
      ?.sha256,
  ).toBe(sha256(firmware));
  const directory = snapshot.occurrences.find(
    (row) => row.logical_path === "firmware",
  );
  expect(directory?.parent_occurrence_id).toBe(root?.occurrence_id);
  expect(child?.parent_occurrence_id).toBe(directory?.occurrence_id);
  expect(await parseBinaryTarget(path)).toMatchObject({
    ok: true,
    value: { kind: "archive", format: "iso9660" },
  });
});
