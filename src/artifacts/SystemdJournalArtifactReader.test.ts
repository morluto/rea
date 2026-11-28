import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { SystemdJournalArtifactReader } from "./SystemdJournalArtifactReader.js";
import { ArtifactFileSource } from "../resources/ArtifactFileSource.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

import {
  HEADER_BYTES,
  journalBytes,
} from "../domain/linux/systemdJournal.fixture.js";

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

it("recognizes a damaged journal through normal inventory", async () => {
  // Recognition is by signature alone; a header that cannot anchor its object
  // area still reaches this reader, which reports the header facts it read and
  // the limitation, instead of falling back to a plain-file occurrence.
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "damaged-header.journal",
      journalBytes({ headerSize: 276, objects: [{ type: 1, size: 64 }] }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    kind: "systemd-journal",
    object_count: 0,
    header: { header_size: 276 },
  });
});

it("accepts a 208-byte legacy header and omits the fields it does not carry", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "legacy.journal",
      journalBytes({
        headerSize: 208,
        objects: [{ type: 1, size: 64 }],
      }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    object_count: 1,
    valid_object_count: 1,
    header: {
      header_size: 208,
      n_data: null,
      n_fields: null,
      n_tags: null,
      tail_entry_offset: null,
    },
  });
});

it("advances past an object whose size is not a multiple of eight", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "unaligned-size.journal",
      journalBytes({
        objects: [
          { type: 1, size: 60 },
          { type: 3, size: 32 },
        ],
      }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    object_count: 2,
    valid_object_count: 2,
    truncated_object_count: 0,
  });
});

it("ends the chain at the declared tail object instead of walking arena capacity", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "preallocated.journal",
      journalBytes({
        objects: [{ type: 1, size: 64 }],
        tailObjectOffset: HEADER_BYTES,
        tailBytes: 64,
      }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    object_count: 1,
    valid_object_count: 1,
    truncated_object_count: 0,
    trailing_bytes: 64,
  });
  expect(inventory.limitations.join(" ")).not.toMatch(
    /declared size does not fit/iu,
  );
});

it("refuses to describe objects under incompatible flags it does not know", async () => {
  const path = await writeJournal(
    "unknown-flags.journal",
    journalBytes({
      incompatibleFlags: 1 << 5,
      objects: [{ type: 1, size: 64 }],
    }),
  );
  const reader = new SystemdJournalArtifactReader(path);
  try {
    // The file is complete; only its layout is outside this reader's
    // coverage, so callers must not be told to obtain a fresh copy.
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "unsupported",
      cause: { failure: { kind: "unsupported" } },
    });
  } finally {
    await reader.close();
  }
});

it("reads the compact tail-array fields as 32-bit values", async () => {
  const bytes = journalBytes({ headerSize: HEADER_BYTES });
  bytes.writeUInt32LE(0x1234, 256);
  bytes.writeUInt32LE(7, 260);
  bytes.writeBigUInt64LE(0x99n, 264);
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal("compact-tail.journal", bytes),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    header: {
      tail_entry_array_offset: 0x1234,
      tail_entry_array_n_entries: 7,
      tail_entry_offset: 0x99,
    },
  });
});

it("reports a header field above 2^53-1 as the ceiling and names it", async () => {
  const bytes = journalBytes({ headerSize: HEADER_BYTES });
  bytes.writeBigUInt64LE((1n << 60n) + 3n, 192);
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal("overflow.journal", bytes),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    header: {
      tail_entry_realtime: Number.MAX_SAFE_INTEGER,
      overflowed_fields: ["tail_entry_realtime"],
    },
  });
  expect(inventory.limitations.join(" ")).toMatch(/above 2\^53-1/u);
});

it("does not claim compressed payloads were skipped when no object is compressed", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "advertised-compression.journal",
      journalBytes({
        incompatibleFlags: 0x1,
        objects: [{ type: 1, size: 64 }],
      }),
    ),
  );
  const limitations = inventory.limitations.join(" ");
  expect(limitations).toMatch(/advertises a compression algorithm/u);
  expect(limitations).not.toMatch(
    /compressed object payloads are not decompressed/u,
  );
});

it("refuses a file that does not begin with the journal signature", async () => {
  const path = await writeJournal("not-journal", Buffer.alloc(512, 0x20));
  const reader = new SystemdJournalArtifactReader(path);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ reason: "malformed" });
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
    ).rejects.toMatchObject({ reason: "malformed" });
  } finally {
    await reader.close();
  }
});

it("reports a short signed journal as truncated rather than malformed", async () => {
  // The signature establishes the format before any structure does: 8 bytes
  // of header in a 40-byte file is truncated input, not bytes of an unknown
  // shape, and the failure carries that distinction for callers.
  const path = await writeJournal(
    "short-signed",
    Buffer.concat([Buffer.from("LPKSHHRH", "latin1"), Buffer.alloc(32)]),
  );
  const reader = new SystemdJournalArtifactReader(path);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "truncated",
      cause: { failure: { kind: "truncated" } },
    });
  } finally {
    await reader.close();
  }
});

it("clamps an inline object window without changing the walked chain", async () => {
  const objects = Array.from({ length: 40 }, () => ({ type: 1, size: 32 }));
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal("many.journal", journalBytes({ objects })),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    object_count: 40,
    omitted_object_headers: 8,
  });
  expect(inventory.occurrences[0]?.format_metadata).toHaveProperty(
    "object_headers.length",
    32,
  );
  // Later headers are paged by re-reading the file; the inline metadata no
  // longer advertises a continuation of its own.
  expect(inventory.occurrences[0]?.format_metadata).not.toHaveProperty(
    "next_object_header_index",
  );
});

it("starts the object-header window at a selected index", async () => {
  const objects = Array.from({ length: 40 }, () => ({ type: 1, size: 32 }));
  const path = await writeJournal(
    "windowed.journal",
    journalBytes({ objects }),
  );
  const reader = new SystemdJournalArtifactReader(path, undefined, {
    objectHeaderStart: 32,
  });
  try {
    for await (const _entry of reader.entries()) {
      // No members.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "systemd-journal")
      throw new Error("Expected systemd-journal metadata");
    // The whole chain is still walked and counted; only the window moves.
    expect(metadata.object_count).toBe(40);
    expect(metadata.object_headers).toHaveLength(8);
    expect(metadata.object_headers[0]?.offset).toBe(HEADER_BYTES + 32 * 32);
  } finally {
    await reader.close();
  }
});

it("keeps the observed state of a header that cannot anchor its objects", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal(
      "unanchored-state.journal",
      journalBytes({
        headerSize: 276,
        state: 2,
        objects: [{ type: 1, size: 64 }],
      }),
    ),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    header: { header_size: 276, state: "archived" },
  });
});

it("treats a zero arena size as an empty arena, not an absent one", async () => {
  const bytes = journalBytes({ objects: [{ type: 1, size: 64 }] });
  bytes.writeBigUInt64LE(0n, 96);
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal("zero-arena.journal", bytes),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    header: { arena_size: 0 },
    object_count: 1,
    valid_object_count: 0,
  });
  expect(inventory.limitations.join(" ")).toMatch(
    /past the end of the arena the header declares/u,
  );
});

it("reports declared arena bytes the file does not hold", async () => {
  const bytes = journalBytes({ objects: [{ type: 1, size: 64 }] });
  // The objects and counts agree, but the arena claims 4 KiB more than exists.
  bytes.writeBigUInt64LE(BigInt(bytes.length - HEADER_BYTES + 4096), 96);
  const inventory = await scanCanonicalArtifactInventory(
    await writeJournal("short-arena.journal", bytes),
  );
  expect(inventory.occurrences[0]?.format_metadata).toMatchObject({
    valid_object_count: 1,
  });
  expect(inventory.limitations.join(" ")).toMatch(
    /4096 declared arena byte\(s\) are absent/u,
  );
});

it("reports a journal that shrinks while it is read as changed, not truncated", async () => {
  const path = await writeJournal(
    "shrinking.journal",
    journalBytes({ objects: [{ type: 1, size: 64 }] }),
  );
  const reader = new SystemdJournalArtifactReader(path);
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(async function (this: ArtifactFileSource, signal) {
      const admitted = await read.call(this, signal);
      // The decoder now meets EOF inside the header it was admitted for.
      await truncate(path, 40);
      return admitted;
    });
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "container-identity",
    });
  } finally {
    spy.mockRestore();
    await reader.close();
  }
});
