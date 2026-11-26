import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { expect, it } from "vitest";

import { QualcommMbnArtifactReader } from "./QualcommMbnArtifactReader.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import {
  mbnElfImage,
  mbnElfWithHashSegment,
  mbnLegacyImage,
} from "../domain/qualcommMbnImage.fixture.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeMbn = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-mbn-", name, bytes);

const CODE = Buffer.alloc(200, 0xab);
const SIGNATURE = Buffer.alloc(256, 0x5a);
const CERTIFICATES = Buffer.alloc(96, 0xc3);
const LEGACY = mbnLegacyImage({
  code: CODE,
  signature: SIGNATURE,
  certificateChain: CERTIFICATES,
});

const readAll = async (reader: QualcommMbnArtifactReader) => {
  const coverage: unknown[] = [];
  const entries = [];
  for await (const entry of reader.entries(undefined, {
    onCoverage: (value) => coverage.push(value),
  }))
    entries.push(entry);
  return { entries, coverage };
};

it("inventories a legacy MBN by content and lists its regions", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeMbn("sbl1.mbn", LEGACY),
  );
  expect(snapshot.manifest.root_format).toBe("qualcomm-mbn");
  expect(snapshot.coverage).toMatchObject({
    scope: "container-entries",
    status: "complete",
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    format_metadata: {
      kind: "qualcomm-mbn",
      layout: "legacy",
      header: {
        version: 3,
        image_id: 21,
        image_source: 0,
        image_source_name: null,
        code_size: 200,
        signature_size: 256,
        certificate_chain_size: 96,
        ranges: { signature: { offset: 240, length: 256 } },
      },
      elf: null,
    },
  });
  const regions = Object.fromEntries(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => [row.logical_path, row.source_location]),
  );
  expect(regions).toMatchObject({
    "header.bin": { offset: 0, length: 40 },
    "code.bin": { offset: 40, length: 200 },
    "signature.bin": { offset: 240, length: 256 },
    "certificate-chain.bin": { offset: 496, length: 96 },
  });
});

it("keeps a DOS MZ executable that resembles MBN v3 classified as dos-mz", async () => {
  const dosMz = Buffer.alloc(1536);
  dosMz.set([0x4d, 0x5a], 0);
  dosMz.writeUInt16LE(3, 4);
  dosMz.writeUInt16LE(4, 8);
  dosMz.writeUInt16LE(256, 16);
  dosMz.writeUInt16LE(256, 20);
  const snapshot = await scanCanonicalArtifactInventory(
    await writeMbn("program.exe", dosMz),
  );
  expect(snapshot.manifest.root_format).toBe("dos-mz");
});

it("opens region bytes and omits ranges past the file end", async () => {
  const path = await writeMbn("truncated.mbn", LEGACY.subarray(0, 400));
  const reader = new QualcommMbnArtifactReader(path);
  try {
    const { entries, coverage } = await readAll(reader);
    expect(entries.map((entry) => entry.path)).toEqual([
      "header.bin",
      "code.bin",
    ]);
    expect(coverage).toEqual([
      {
        status: "unknown",
        limitations: [
          "image range 0+592 exceeds the 400-byte file",
          "signature range 240+256 exceeds the 400-byte file",
          "certificate chain range 496+96 exceeds the 400-byte file",
        ],
      },
    ]);
    expect((await buffer(await reader.open(entries[1]!))).equals(CODE)).toBe(
      true,
    );
    expect(reader.formatMetadata()?.header?.ranges.signature).toEqual({
      offset: 240,
      length: 256,
    });
  } finally {
    await reader.close();
  }
});

it("reports an ELF MBN's hash segment header and hash count", async () => {
  const path = await writeMbn("modem.mdt", mbnElfWithHashSegment({ loads: 2 }));
  const reader = new QualcommMbnArtifactReader(path);
  try {
    const { entries, coverage } = await readAll(reader);
    expect(coverage).toEqual([{ status: "complete", limitations: [] }]);
    expect(entries.map((entry) => entry.path)).toEqual([
      "header.bin",
      "hash-table.bin",
      "signature.bin",
      "certificate-chain.bin",
    ]);
    expect(reader.formatMetadata()).toMatchObject({
      layout: "elf",
      header: { code_size: 128, signature_size: 256 },
      elf: {
        elf_class: 32,
        machine: 164,
        program_header_count: 4,
        hash_segment_program_header: 1,
        hash_segment_offset: 192,
        hash_size: 32,
        hash_count: 4,
      },
    });
    expect(reader.formatMetadata()?.elf?.segment_hashes).toHaveLength(4);
  } finally {
    await reader.close();
  }
});

it("keeps header.bin and decoded header metadata when an ELF hash table runs past EOF", async () => {
  const image = mbnElfWithHashSegment({ loads: 1 });
  const truncated = image.subarray(0, 200);
  const path = await writeMbn("truncated-table.mdt", truncated);
  const reader = new QualcommMbnArtifactReader(path);
  try {
    const { entries, coverage } = await readAll(reader);
    expect(entries.map((entry) => entry.path)).toEqual(["header.bin"]);
    expect(
      (await buffer(await reader.open(entries[0]!))).equals(
        truncated.subarray(160, 200),
      ),
    ).toBe(true);
    expect(coverage).toEqual([
      {
        status: "unknown",
        limitations: [
          "image range 160+488 exceeds the 200-byte file",
          "hash table range 200+96 exceeds the 200-byte file",
          "signature range 296+256 exceeds the 200-byte file",
          "certificate chain range 552+96 exceeds the 200-byte file",
        ],
      },
    ]);
    expect(reader.formatMetadata()).toMatchObject({
      kind: "qualcomm-mbn",
      layout: "elf",
      header: {
        version: 3,
        header_bytes: 40,
        code_size: 96,
        signature_size: 256,
        certificate_chain_size: 96,
        ranges: {
          header: { offset: 160, length: 40 },
          code: { offset: 200, length: 96 },
        },
      },
      elf: {
        hash_segment_program_header: 1,
        hash_segment_offset: 160,
        hash_size: 32,
        hash_count: 3,
      },
    });
  } finally {
    await reader.close();
  }
});

it("omits stored regions that exceed the hash segment p_filesz", async () => {
  const image = mbnElfWithHashSegment({ version: 5 });
  image.writeUInt32LE(40, 52 + 32 + 16); // p_filesz of the second ELF32 program header
  const path = await writeMbn("short-segment.mdt", image);
  const reader = new QualcommMbnArtifactReader(path);
  try {
    const { entries, coverage } = await readAll(reader);
    expect(entries.map((entry) => entry.path)).toEqual(["header.bin"]);
    expect(coverage).toMatchObject([{ status: "unknown" }]);
    expect(reader.formatMetadata()).toMatchObject({
      header: {
        version: 5,
        header_bytes: 40,
        ranges: { code: { offset: 200, length: 96 } },
      },
      elf: { hash_segment_file_size: 40, segment_hashes: [] },
    });
  } finally {
    await reader.close();
  }
});

it("inventories an ELF with a hash segment as MBN by content", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeMbn("modem.elf", mbnElfWithHashSegment({ loads: 2 })),
  );
  expect(snapshot.manifest.root_format).toBe("qualcomm-mbn");
  expect(snapshot.coverage).toMatchObject({ status: "complete" });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    format_metadata: {
      kind: "qualcomm-mbn",
      layout: "elf",
      header: { code_size: 128 },
      elf: {
        hash_segment_program_header: 1,
        hash_size: 32,
        hash_count: 4,
        omitted_segment_hashes: 0,
      },
    },
  });
  expect(
    snapshot.occurrences
      .map((row) => row.logical_path)
      .filter((path) => path !== ".")
      .sort(),
  ).toEqual([
    "certificate-chain.bin",
    "hash-table.bin",
    "header.bin",
    "signature.bin",
  ]);
});

it("extracts an ELF MBN resolved as an ELF target", async () => {
  const image = mbnElfWithHashSegment({ loads: 1 });
  const path = await writeMbn("modem.elf", image);
  const directory = await createTestTempDirectory("rea-mbn-out-");
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "record-and-continue",
      resourceScope,
    });
    const table = await readFile(join(extracted.output_root, "hash-table.bin"));
    expect(table.equals(Buffer.alloc(96, 0x11))).toBe(true);
  } finally {
    await resourceScope.close();
  }
});

it("keeps an ELF without a hash segment classified as ELF", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeMbn(
      "plain.elf",
      mbnElfImage([{ type: 1, flags: 5, data: Buffer.alloc(32, 1) }]),
    ),
  );
  expect(snapshot.manifest.root_format).toBe("elf");
});

it("lists the first segment hashes inline and counts the rest", async () => {
  const path = await writeMbn("big.mdt", mbnElfWithHashSegment({ loads: 70 }));
  const reader = new QualcommMbnArtifactReader(path);
  try {
    const { coverage } = await readAll(reader);
    expect(coverage).toEqual([{ status: "complete", limitations: [] }]);
    const elf = reader.formatMetadata()?.elf;
    expect(elf).toMatchObject({ hash_count: 72, omitted_segment_hashes: 8 });
    expect(elf?.segment_hashes).toHaveLength(64);
  } finally {
    await reader.close();
  }
});

it("publishes null hash_size and hash_count when code_size 192 does not match 3 program headers", async () => {
  const hashSegment = mbnLegacyImage({
    imageId: 0,
    destination: 0x8810_0028,
    code: Buffer.alloc(192, 0x11),
    signature: Buffer.alloc(64, 0x5a),
    certificateChain: Buffer.alloc(32, 0xc3),
  });
  const path = await writeMbn(
    "ambiguous-hash.mdt",
    mbnElfImage([
      { type: 0, flags: 0x0700_0000, data: Buffer.alloc(0) },
      { type: 0, flags: 0x0220_0000, data: hashSegment },
      { type: 1, flags: 5, data: Buffer.alloc(16, 1) },
    ]),
  );
  const reader = new QualcommMbnArtifactReader(path);
  try {
    const { coverage } = await readAll(reader);
    expect(coverage).toEqual([
      {
        status: "unknown",
        limitations: [
          "code size 192 does not match the 3 program headers (fits 6 32-byte or 4 48-byte hashes); hash size and count are unknown",
        ],
      },
    ]);
    expect(reader.formatMetadata()).toMatchObject({
      layout: "elf",
      header: { code_size: 192 },
      elf: {
        program_header_count: 3,
        hash_size: null,
        hash_count: null,
        segment_hashes: [],
        omitted_segment_hashes: 0,
      },
    });
  } finally {
    await reader.close();
  }
});

it("fails an ELF without a hash segment when read directly", async () => {
  const reader = new QualcommMbnArtifactReader(
    await writeMbn(
      "plain.elf",
      mbnElfImage([{ type: 1, flags: 5, data: Buffer.alloc(32, 1) }]),
    ),
  );
  try {
    await expect(readAll(reader)).rejects.toMatchObject({
      reason: "malformed",
      parseFailure: { format: "qualcomm-mbn", field: "header" },
    });
  } finally {
    await reader.close();
  }
});

it("fails bytes that are not an MBN header", async () => {
  const reader = new QualcommMbnArtifactReader(
    await writeMbn("zero.mbn", Buffer.alloc(64)),
  );
  try {
    await expect(readAll(reader)).rejects.toMatchObject({
      reason: "malformed",
      parseFailure: { format: "qualcomm-mbn", field: "header" },
    });
  } finally {
    await reader.close();
  }
});
