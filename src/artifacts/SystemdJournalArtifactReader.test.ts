import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { SystemdJournalArtifactReader } from "./SystemdJournalArtifactReader.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const HEADER_BYTES = 272;

interface ObjectSpec {
  readonly type: number;
  readonly flags?: number;
  readonly size: number;
}

/** A minimal, structurally valid journal: fixed header plus aligned objects. */
const journalBytes = (
  options: {
    readonly objects?: readonly ObjectSpec[];
    readonly headerSize?: number;
    readonly nObjects?: number;
    readonly state?: number;
    readonly incompatibleFlags?: number;
    readonly compatibleFlags?: number;
    readonly tailBytes?: number;
  } = {},
): Buffer => {
  const objects = options.objects ?? [];
  const bodySize = objects.reduce(
    (total, object) => total + Math.min(object.size, 64),
    0,
  );
  /** The object area begins after the declared header, which may exceed 272. */
  const objectStart = Math.max(
    HEADER_BYTES,
    options.headerSize ?? HEADER_BYTES,
  );
  const file = Buffer.alloc(objectStart + bodySize + (options.tailBytes ?? 0));
  file.write("LPKSHHRH", 0, "latin1");
  file.writeUInt32LE(options.compatibleFlags ?? 0, 8);
  file.writeUInt32LE(options.incompatibleFlags ?? 0, 12);
  file.writeUInt8(options.state ?? 1, 16);
  for (let index = 0; index < 4; index += 1)
    file.fill(0x10 + index, 24 + index * 16, 24 + (index + 1) * 16);
  file.writeBigUInt64LE(BigInt(options.headerSize ?? HEADER_BYTES), 88);
  file.writeBigUInt64LE(BigInt(file.length - objectStart), 96);
  file.writeBigUInt64LE(BigInt(options.nObjects ?? objects.length), 144);
  /** An oversized object is written only as far as the file's stub for it. */
  let offset = objectStart;
  for (const object of objects) {
    file.writeUInt8(object.type, offset);
    file.writeUInt8(object.flags ?? 0, offset + 1);
    file.writeBigUInt64LE(BigInt(object.size), offset + 8);
    offset += Math.min(object.size, 64);
  }
  return file;
};

const writeJournal = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-systemd-journal-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

it("reports a journal file's header and object headers as the root occurrence", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "system.journal",
      journalBytes({
        objects: [
          { type: 1, size: 64 },
          { type: 3, size: 48 },
          { type: 3, size: 48 },
        ],
      }),
    ),
  );
  expect(inventory.manifest.root_format).toBe("systemd-journal");
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_format: "systemd-journal",
    format_metadata: {
      kind: "systemd-journal",
      object_count: 3,
      valid_object_count: 3,
      truncated_object_count: 0,
      object_type_counts: [
        { type: "data", count: 1 },
        { type: "entry", count: 2 },
      ],
      header: {
        state: "online",
        header_size: HEADER_BYTES,
        n_objects: 3,
      },
    },
  });
});

it("names every flag bit the header and objects declare", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "flags.journal",
      journalBytes({
        compatibleFlags: 0x1 | 0x4,
        incompatibleFlags: 0x2 | 0x10,
        objects: [{ type: 1, flags: 0x2, size: 64 }],
      }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    header: {
      compatible_flag_names: ["sealed", "sealed-continuous"],
      incompatible_flag_names: ["compressed-lz4", "compact"],
    },
    object_headers: [{ flag_names: ["compressed-lz4"], compressed: true }],
  });
});

it("stops the object chain at an object whose declared size overruns the file", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "truncated.journal",
      journalBytes({
        objects: [
          { type: 1, size: 64 },
          { type: 3, size: 4096 },
        ],
      }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    object_count: 2,
    valid_object_count: 1,
    truncated_object_count: 1,
    trailing_bytes: 64,
  });
  expect(inventory.limitations.join(" ")).toMatch(
    /declared size does not fit/iu,
  );
});

it("reports a tail too short to hold an object header", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "tail.journal",
      journalBytes({ objects: [{ type: 1, size: 64 }], tailBytes: 6 }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    valid_object_count: 1,
    trailing_bytes: 6,
  });
});

it("keeps an object with an unknown type rather than guessing it", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "unknown-type.journal",
      journalBytes({ objects: [{ type: 0x2a, size: 64 }] }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    unknown_type_object_count: 1,
    object_type_counts: [{ type: "unknown-42", count: 1 }],
  });
});

it("does not walk objects when the declared header size cannot anchor them", async () => {
  // 276 is inside the file but not 8-byte aligned, so the object area has no
  // trustworthy start; a byte-aligned edge reported as a limitation, not a guess.
  const path = await writeJournal(
    "header-size.journal",
    journalBytes({ headerSize: 276, objects: [{ type: 1, size: 64 }] }),
  );
  const reader = new SystemdJournalArtifactReader(path);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({ done: true });
    expect(reader.formatMetadata()).toMatchObject({
      kind: "systemd-journal",
      object_count: 0,
      header: { header_size: 276 },
    });
  } finally {
    await reader.close();
  }
});

it("refuses a file that does not begin with the journal signature", async () => {
  const path = await writeJournal("not-journal", Buffer.alloc(512, 0x20));
  const reader = new SystemdJournalArtifactReader(path);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "format" });
  } finally {
    await reader.close();
  }
});

it("refuses a file shorter than the fixed header", async () => {
  const path = await writeJournal("short", Buffer.alloc(64));
  const reader = new SystemdJournalArtifactReader(path);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "format" });
  } finally {
    await reader.close();
  }
});

it("clamps an inline object window without changing the walked chain", async () => {
  const objects = Array.from({ length: 40 }, () => ({ type: 1, size: 32 }));
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal("many.journal", journalBytes({ objects })),
  );
  const metadata = inventory.occurrences[0]?.format_metadata as {
    object_count: number;
    object_headers: unknown[];
    omitted_object_headers: number;
    next_object_header_index: number | null;
  };
  expect(metadata.object_count).toBe(40);
  expect(metadata.object_headers).toHaveLength(32);
  expect(metadata.omitted_object_headers).toBe(8);
  expect(metadata.next_object_header_index).toBe(32);
});
