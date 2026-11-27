import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { amigaLoadFile, amigaObjectFile } from "../domain/amigaHunk.fixture.js";
import { parseAmigaHunk } from "../domain/amigaHunk.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const CODE = Buffer.from([0x4e, 0x75, 0x4e, 0x75]);
const DATA = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x00]);

const loadFile = () =>
  amigaLoadFile({
    libraries: ["dos.library"],
    hunks: [
      {
        type: "code",
        bytes: CODE,
        memory: "chip",
        name: "start",
        relocs: [{ kind: "reloc32", target: 1, offsets: [0] }],
        symbols: [{ name: "start", offset: 0 }],
        debug: Buffer.from("dbg"),
      },
      {
        type: "data",
        bytes: DATA,
        memory: "fast",
        relocs: [{ kind: "drel32", target: 0, offsets: [0, 4] }],
      },
      { type: "bss", longwords: 4, memory: "extended", extendedFlags: 0x2 },
    ],
  });

it("inventories a load file and extracts stored code and data hunks", async () => {
  const bytes = loadFile();
  const drel = bytes.indexOf(Buffer.from([0x00, 0x00, 0x03, 0xf7]));
  expect(bytes.readUInt16BE(drel + 4)).toBe(2);
  expect(bytes.readUInt16BE(drel + 6)).toBe(0);
  expect(bytes.readUInt16BE(drel + 8)).toBe(0);
  expect(bytes.readUInt16BE(drel + 10)).toBe(4);
  const parsed = parseAmigaHunk(bytes);
  const path = await createTestTempFile(
    "rea-amiga-hunk-",
    "program.hunk",
    bytes,
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("amiga-hunk");
  expect(snapshot.coverage.status).toBe("complete");
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    artifact_kind: "container",
    format_metadata: {
      kind: "amiga-hunk",
      file_kind: "load",
      resident_libraries: ["dos.library"],
      first_hunk: 0,
      last_hunk: 2,
      hunks: [
        {
          index: 0,
          type: "code",
          memory: "chip",
          name: "start",
          relocations: [{ kind: "reloc32", target_hunk: 1, count: 1 }],
          symbols: [{ name: "start", offset: 0 }],
          debug: true,
        },
        {
          index: 1,
          type: "data",
          memory: "fast",
          relocations: [{ kind: "drel32", target_hunk: 0, count: 2 }],
          debug: false,
        },
        {
          index: 2,
          type: "bss",
          memory: "extended",
          extended_flags: 2,
          stored_bytes: null,
          file_offset: null,
        },
      ],
    },
  });
  expect(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => [
        row.logical_path,
        row.source_location,
        row.format_metadata,
      ]),
  ).toEqual(
    parsed.entries.map((entry) => [
      entry.path,
      { offset: entry.byteOffset, length: entry.storedBytes },
      {
        kind: "amiga-hunk-entry",
        hunk: entry.hunk,
        role: entry.role,
        memory: entry.memory,
        declared_bytes: entry.declaredBytes,
        stored_bytes: entry.storedBytes,
      },
    ]),
  );
  expect(parsed.entries.map((entry) => entry.path)).toEqual([
    "hunk-0-code.bin",
    "hunk-1-data.bin",
  ]);

  const directory = await createTestTempDirectory("rea-amiga-hunk-extract-");
  const source = join(directory, "program.hunk");
  await writeFile(source, bytes);
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: source,
      inputFormat: "amiga-hunk",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      (await readFile(join(extracted.output_root, "hunk-0-code.bin"))).equals(
        CODE,
      ),
    ).toBe(true);
    expect(
      (await readFile(join(extracted.output_root, "hunk-1-data.bin"))).equals(
        DATA,
      ),
    ).toBe(true);
  } finally {
    await resourceScope.close();
  }
});

it("lists object units in metadata and extracts no entries", async () => {
  const bytes = amigaObjectFile([
    { name: "obj.o", hunks: [{ type: "code", bytes: CODE }] },
    {
      name: "next.o",
      hunks: [{ type: "data", bytes: DATA, unknownBeforeEnd: 0x3ef }],
    },
  ]);
  const snapshot = await scanCanonicalArtifactInventory(
    await createTestTempFile("rea-amiga-hunk-unit-", "obj.o", bytes),
  );
  expect(snapshot.coverage.status).toBe("unknown");
  expect(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => row.logical_path),
  ).toEqual([]);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    format_metadata: {
      kind: "amiga-hunk",
      file_kind: "object",
      units: [
        { index: 0, name: "obj.o" },
        { index: 1, name: "next.o" },
      ],
    },
  });
});
