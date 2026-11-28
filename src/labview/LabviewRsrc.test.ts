import {
  AnalysisTargetFailureError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { deflateSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { peResourceFixture } from "../domain/pe/peResources.fixture.js";
import { findEmbeddedRsrcContainers } from "./LabviewPeContainer.js";
import { LABVIEW_DECODE_ALLOWANCES, parseLabviewRsrc } from "./LabviewRsrc.js";
import {
  LabviewArtifactProvider,
  labviewReadDialect,
  decodeOmissionLimitations,
} from "./LabviewArtifactProvider.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  buildLabviewRsrc,
  labviewContainer,
  labviewVersionSection,
  labviewZlibSection,
} from "../../tests/fixtures/labview/rsrc.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

describe("parseLabviewRsrc", () => {
  it("inventories blocks and section codings from one container", () => {
    const parsed = parseLabviewRsrc(labviewContainer());
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value).toMatchObject({
      formatVersion: 3,
      fileType: "LVAR",
      creator: "LBVW",
      dataOffset: 32,
      labviewVersion: "11.0",
      blockDiagram: "absent",
      frontPanel: "absent",
    });
    const dfds = parsed.value.blocks.find(
      ({ identifier }) => identifier === "DFDS",
    );
    expect(
      dfds?.sections.map(({ coding, decodedBytes }) => ({
        coding,
        decodedBytes,
      })),
    ).toEqual([
      { coding: "zlib", decodedBytes: 5 },
      { coding: "none", decodedBytes: null },
    ]);
    expect(dfds?.sections[1]?.storedBytes).toBe(4);
  });

  it("locates an RSRC container stored as a PE resource", () => {
    const bytes = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: labviewContainer() },
    ]).bytes;
    const scan = findEmbeddedRsrcContainers(bytes);
    if (!scan.ok) throw scan.failure;
    expect(scan.containers).toHaveLength(1);
    expect(scan.containers[0]?.bytes.equals(labviewContainer())).toBe(true);
  });

  it("reads the version from a zlib-coded vers section", () => {
    const record = labviewVersionSection("11.0");
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([
        { ident: "vers", sections: [labviewZlibSection(record)] },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]).toMatchObject({
      coding: "zlib",
      decodedBytes: record.length,
    });
    expect(parsed.value.labviewVersion).toBe("11.0");
    expect(parsed.value.versionCoverage).toBe("observed");
  });

  it("ignores an RSRC payload outside the RCDATA resource type", () => {
    const bytes = peResourceFixture(true, [
      { type: 11, name: 1, language: 1033, payload: labviewContainer() },
    ]).bytes;
    const scan = findEmbeddedRsrcContainers(bytes);
    if (!scan.ok) throw scan.failure;
    expect(scan.containers).toHaveLength(0);
  });

  it.each([
    [11, 0],
    [10, 1],
  ])(
    "filters a root type-%i leaf by its resource type before reading it",
    (type, expected) => {
      const fixture = peResourceFixture(true, [
        { type, name: 1, language: 1033, payload: labviewContainer() },
      ]);
      // Point the root type entry straight at the data entry, skipping the
      // name and language directories (a noncanonical leaf target).
      const rootEntry = fixture.entryOffsets[0]!;
      const root = fixture.directoryOffsets[0]!;
      fixture.bytes.writeUInt32LE(
        fixture.dataOffsets[0]! - root,
        rootEntry + 4,
      );
      const scan = findEmbeddedRsrcContainers(fixture.bytes);
      if (!scan.ok) throw scan.failure;
      expect(scan.containers).toHaveLength(expected);
    },
  );

  it("reports the fixed decode allowance in the public limitations", async () => {
    const stored = Buffer.concat([
      Buffer.from([0x04, 0x00, 0x00, 0x01]),
      deflateSync(Buffer.from("x")),
    ]);
    const root = await createTestTempDirectory("rea-labview-allowance-");
    const path = join(root, "fixture.vi");
    await writeFile(
      path,
      buildLabviewRsrc([{ ident: "DFDS", sections: [stored] }]),
    );
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    await provider.close();
    if (!result.ok) throw result.error;
    // The parser owns which allowance stopped the section; the delivered
    // guidance is the provider formatter's output for exactly that fact.
    const parsed = parseLabviewRsrc(await readFile(path));
    if (!parsed.ok) throw parsed.failure;
    expect(parsed.value.decodeOmissions).toEqual({ decoded_allowance: 1 });
    const [guidance] = decodeOmissionLimitations(parsed.value.decodeOmissions);
    expect(guidance).toContain(
      String(LABVIEW_DECODE_ALLOWANCES.decoded_allowance),
    );
    expect(result.value.limitations).toContain(guidance);
  });

  it("does not call an unreadable RCDATA branch an absent container", async () => {
    const fixture = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: labviewContainer() },
    ]);
    // The RCDATA type entry now names a subdirectory far outside the span.
    fixture.bytes.writeUInt32LE(0xfffffff0, fixture.entryOffsets[0]! + 4);
    const scan = findEmbeddedRsrcContainers(fixture.bytes);
    if (!scan.ok) throw scan.failure;
    expect(scan).toMatchObject({ containers: [], complete: false });
    const root = await createTestTempDirectory("rea-labview-pe-unread-");
    const path = join(root, "fixture.exe");
    await writeFile(path, fixture.bytes);
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    await provider.close();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).toContain(
      "part of the PE resource tree could not be read",
    );
  });

  it("treats a declared resource root shorter than one directory as unread", () => {
    const fixture = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: labviewContainer() },
    ]);
    // Move the resource RVA to 8 bytes before the section's mapped end.
    const rva = fixture.bytes.readUInt32LE(fixture.directoryAt);
    const virtualSize = fixture.bytes.readUInt32LE(fixture.sectionAt + 8);
    fixture.bytes.writeUInt32LE(rva + virtualSize - 8, fixture.directoryAt);
    const scan = findEmbeddedRsrcContainers(fixture.bytes);
    if (!scan.ok) throw scan.failure;
    expect(scan).toMatchObject({ containers: [], complete: false });
  });

  it("frames directory rows before the entry allowance", () => {
    const fixture = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: labviewContainer() },
    ]);
    // The root directory's ID-entry count (+14) now declares 5000 rows that
    // the resource span cannot hold: an unreadable tree, not capacity.
    fixture.bytes.writeUInt16LE(5000, fixture.directoryOffsets[0]! + 14);
    const scan = findEmbeddedRsrcContainers(fixture.bytes);
    if (!scan.ok) throw scan.failure;
    expect(scan).toMatchObject({ containers: [], complete: false });
  });

  it("keeps a fully framed directory over its entry allowance a capacity refusal", () => {
    const fixture = peResourceFixture(
      true,
      Array.from({ length: 4097 }, (_, index) => ({ type: 1000 + index })),
      262_144,
    );
    const scan = findEmbeddedRsrcContainers(fixture.bytes);
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.failure.failure).toMatchObject({
      kind: "limit",
      limit: {
        name: "pe_resource_directory_entries",
        maximum: 4096,
        required: 4097,
      },
    });
  });

  it("reports where an embedded container starts in the selected file", async () => {
    const bytes = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: labviewContainer() },
    ]).bytes;
    const root = await createTestTempDirectory("rea-labview-pe-offset-");
    const path = join(root, "fixture.exe");
    await writeFile(path, bytes);
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.container.kind).toBe("pe-rcdata-rsrc");
    expect(result.value.container.file_offset).toBeGreaterThan(0);
    // The embedded application container is fully examined.
    expect(result.value.block_diagram).toBe("absent");
    expect(result.value.front_panel).toBe("absent");
    // The reported offset is where the container's own header starts.
    expect(
      bytes
        .subarray(
          result.value.container.file_offset,
          result.value.container.file_offset + 6,
        )
        .toString("latin1"),
    ).toBe("RSRC\r\n");
    await provider.close();
  });

  it("keeps each block's interpretation of shared stored bytes", () => {
    // Point the second block's section start at the first block's stored data.
    // The two blocks must keep their own coding: LVzp is XOR even when the
    // bytes it shares were classified for a DFDS block first.
    const container = buildLabviewRsrc([
      { ident: "DFDS", sections: [labviewZlibSection("hello")] },
      { ident: "LVzp", sections: [Buffer.from("ignored")] },
    ]);
    const infoOffset = container.readUInt32BE(16);
    const blockInfo = infoOffset + container.readUInt32BE(infoOffset + 44);
    const starts0 = container.readUInt32BE(blockInfo + 4 + 8);
    const starts1 = container.readUInt32BE(blockInfo + 4 + 12 + 8);
    const sharedOffset = container.readUInt32BE(blockInfo + starts0 + 12);
    container.writeUInt32BE(sharedOffset, blockInfo + starts1 + 12);
    const parsed = parseLabviewRsrc(container);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]?.coding).toBe("zlib");
    expect(parsed.value.blocks[1]?.sections[0]?.coding).toBe("xor");
  });

  it("preserves a declared section index, including a negative one", () => {
    const container = labviewContainer();
    const infoOffset = container.readUInt32BE(16);
    const blockInfo = infoOffset + container.readUInt32BE(infoOffset + 44);
    const starts0 = container.readUInt32BE(blockInfo + 4 + 8);
    container.writeInt32BE(-1, blockInfo + starts0);
    const parsed = parseLabviewRsrc(container);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    // The stored value is the fact; renumbering it would invent an index.
    expect(parsed.value.blocks[0]?.sections[0]?.index).toBe(-1);
  });

  it("resolves section names against the shared name list", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc(
        [
          { ident: "vers", sections: [labviewVersionSection()] },
          { ident: "DFDS", sections: [Buffer.from("x")] },
        ],
        ["shared"],
      ),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    // Both blocks read the one name list after every start table.
    expect(parsed.value.blocks.map((block) => block.sections[0]?.name)).toEqual(
      ["shared", "shared"],
    );
  });

  it("reads a name list that follows LabVIEW's declared list extent", () => {
    // LabVIEW counts the extent from the info header, so it ends where the
    // name list begins and the names run to the end of the info section.
    const name = "MDFBuildDevPartMerger_PopulateMsiDriverPackagesTable.vi";
    const container = buildLabviewRsrc(
      [{ ident: "LVSR", sections: [Buffer.from("x")] }],
      [name],
    );
    const infoOffset = container.readUInt32BE(16);
    const infoBytes = container.readUInt32BE(20);
    container.writeUInt32BE(infoBytes - 1 - name.length, infoOffset + 48);
    const parsed = parseLabviewRsrc(container);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]?.name).toBe(name);
  });

  it("rejects a block-info extent that ends before the section-start tables", () => {
    // The declared extent stops one byte before the start tables end, while
    // the trailing name keeps the info section past that table.
    const name = "MDFBuildDevPartMerger_PopulateMsiDriverPackagesTable.vi";
    const container = buildLabviewRsrc(
      [{ ident: "LVSR", sections: [Buffer.from("x")] }],
      [name],
    );
    const infoOffset = container.readUInt32BE(16);
    const infoEnd = infoOffset + container.readUInt32BE(20);
    const blockInfo = infoOffset + container.readUInt32BE(infoOffset + 44);
    const headerAt = blockInfo + 4;
    const startsAt = blockInfo + container.readUInt32BE(headerAt + 8);
    const structureEnd = infoOffset + container.readUInt32BE(infoOffset + 48);
    const declared = structureEnd - infoOffset - 1;
    expect(blockInfo + declared).toBeGreaterThanOrEqual(structureEnd);
    expect(infoEnd).toBeGreaterThan(blockInfo + declared);
    container.writeUInt32BE(declared, infoOffset + 48);
    const parsed = parseLabviewRsrc(container);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure).toMatchObject({
      kind: "truncated",
      format: "labview-rsrc",
      offset: startsAt,
      field: "LVSR",
    });
  });

  it("accepts a list extent that runs past the resource payload", () => {
    // A real LabVIEW-built PE declares more list bytes than its resource
    // payload holds; the records it actually uses still fit.
    const container = Buffer.from(labviewContainer());
    const infoOffset = container.readUInt32BE(16);
    container.writeUInt32BE(
      container.readUInt32BE(infoOffset + 48) + 1000,
      infoOffset + 48,
    );
    const parsed = parseLabviewRsrc(container);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks.map(({ identifier }) => identifier)).toEqual([
      "vers",
      "DFDS",
    ]);
  });

  it("reports the XOR-coded program tree and retained heaps", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([
        { ident: "LVzp", sections: [Buffer.from("\x00\x00\x00\x01abc")] },
        { ident: "BDHc", sections: [Buffer.from("diagram")] },
        { ident: "FPHb", sections: [Buffer.from("panel")] },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blockDiagram).toBe("present");
    expect(parsed.value.frontPanel).toBe("present");
    expect(parsed.value.blocks[0]?.sections[0]).toMatchObject({
      coding: "xor",
      decodedBytes: null,
    });
  });

  it("reports an undecodable vers record as unknown rather than absent", () => {
    const corrupted = labviewZlibSection(labviewVersionSection("11.0"));
    // Inflating to one byte less than declared fails the classification.
    corrupted.writeUInt32BE(corrupted.readUInt32BE(0) + 1, 0);
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "vers", sections: [corrupted] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]?.coding).toBe("unknown");
    expect(parsed.value.labviewVersion).toBeNull();
    expect(parsed.value.versionCoverage).toBe("unknown");
  });

  it("rejects a packed version whose digits are not decimal", () => {
    const damaged = Buffer.alloc(8, 0xff);
    const valid = labviewVersionSection("11.0");
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "vers", sections: [damaged, valid] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    // The damaged record is not a version; the next record still is.
    expect(parsed.value.labviewVersion).toBe("11.0");
    expect(parsed.value.versionCoverage).toBe("observed");
  });

  it("reads major.minor without validating the build field", () => {
    // LabVIEW 11.0, release stage (4), build 10 written as a binary count:
    // 0x11 major digits, minor 0, bugfix 0, 0x800a stage and build bits.
    const record = Buffer.from([0x11, 0x00, 0x80, 0x0a, 0, 0, 0, 0]);
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "vers", sections: [record] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.labviewVersion).toBe("11.0");
    expect(parsed.value.versionCoverage).toBe("observed");
  });

  it("reports a minor nibble above 9 as an unknown version", () => {
    const record = Buffer.from([0x11, 0xa0, 0x80, 0x00, 0, 0, 0, 0]);
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "vers", sections: [record] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.labviewVersion).toBeNull();
    expect(parsed.value.versionCoverage).toBe("unknown");
  });

  it("treats a preset-dictionary zlib vers section as undecodable zlib", () => {
    // Declared length 8, then RFC 1950 header 78 bb (FDICT set, FCHECK
    // valid) and a dictionary id. The length prefix must not read as 0.0.
    const stored = Buffer.from([
      0, 0, 0, 8, 0x78, 0xbb, 0x12, 0x34, 0x56, 0x78, 0x03, 0x00,
    ]);
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "vers", sections: [stored] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]?.coding).toBe("unknown");
    expect(parsed.value.labviewVersion).toBeNull();
    expect(parsed.value.versionCoverage).toBe("unknown");
    expect(parsed.value.decodeOmissions).toEqual({ preset_dictionary: 1 });
  });

  it("names the decode allowance that stopped a section", () => {
    // A valid zlib header whose declared output exceeds the 64 MiB decoded
    // allowance is refused before any allocation.
    const stored = Buffer.concat([
      Buffer.from([0x04, 0x00, 0x00, 0x01]),
      deflateSync(Buffer.from("x")),
    ]);
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "DFDS", sections: [stored] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]?.coding).toBe("unknown");
    expect(parsed.value.decodeOmissions).toEqual({ decoded_allowance: 1 });
  });

  it("reports a damaged-only vers record as unknown", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "vers", sections: [Buffer.alloc(8, 0xff)] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.labviewVersion).toBeNull();
    expect(parsed.value.versionCoverage).toBe("unknown");
  });

  it("reports version coverage absent when the container has no vers record", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([{ ident: "DFDS", sections: [Buffer.from("x")] }]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.labviewVersion).toBeNull();
    expect(parsed.value.versionCoverage).toBe("absent");
  });

  it("fails a truncated or non-RSRC container instead of returning a partial inventory", () => {
    expect(parseLabviewRsrc(Buffer.from("not a container"))).toMatchObject({
      ok: false,
    });
    expect(parseLabviewRsrc(labviewContainer().subarray(0, 40))).toMatchObject({
      ok: false,
    });
  });
});

describe("LabviewArtifactProvider", () => {
  it("inspects a selected RSRC file and binds its identity", async () => {
    const root = await createTestTempDirectory("rea-labview-rsrc-");
    const path = join(root, "fixture.vi");
    const bytes = labviewContainer();
    await writeFile(path, bytes);
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.artifact).toMatchObject({ path, bytes: bytes.length });
    expect(result.value.artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.value.container).toMatchObject({
      kind: "rsrc",
      embedded_containers: 1,
    });
    expect(result.value.labview_version).toBe("11.0");
    await provider.close();
  });

  it("refuses a selected file that is not a LabVIEW container", async () => {
    const root = await createTestTempDirectory("rea-labview-bad-");
    const path = join(root, "fixture.bin");
    await writeFile(path, Buffer.from("not a LabVIEW artifact"));
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
    await provider.close();
  });

  it("reports cancellation that arrives after the read starts", async () => {
    const root = await createTestTempDirectory("rea-labview-cancel-");
    const path = join(root, "fixture.vi");
    await writeFile(path, labviewContainer());
    const controller = new AbortController();
    const reason = { request: "cancel LabVIEW inspection" };
    const provider = new LabviewArtifactProvider();
    // Start the inspection, then cancel while its stable read is in flight.
    const pending = provider.inspect({ path }, { signal: controller.signal });
    controller.abort(reason);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The read records the cancellation at its own owner; the public
      // projection is what callers act on.
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
      expect(result.error.cause).toBe(reason);
    }
    await provider.close();
  });

  it("keeps heap presence unknown for a direct RSRC container", async () => {
    const root = await createTestTempDirectory("rea-labview-direct-");
    // The name does not establish the format: a renamed archive must not
    // become a proven absence.
    const path = join(root, "fixture.vi");
    await writeFile(path, labviewContainer());
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.block_diagram).toBe("unknown");
    expect(result.value.front_panel).toBe("unknown");
    expect(result.value.limitations.join(" ")).toContain(
      "cannot establish from its content",
    );
    await provider.close();
  });

  /** Inspect bytes and return the input refusal message, failing on any other outcome. */
  const refusalMessage = async (name: string, bytes: Buffer) => {
    const root = await createTestTempDirectory("rea-labview-refusal-");
    const path = join(root, name);
    await writeFile(path, bytes);
    const provider = new LabviewArtifactProvider();
    try {
      const result = await provider.inspect({ path });
      if (result.ok) throw new Error("expected a refusal");
      expect(result.error).toBeInstanceOf(AnalysisInputError);
      if (!(result.error instanceof AnalysisInputError)) throw result.error;
      return result.error.issues[0]?.message ?? "";
    } finally {
      await provider.close();
    }
  };

  /** A 64-byte DOS header whose e_lfanew points at `signature`. */
  const mzWith = (signature: string, trailing = 0): Buffer => {
    const header = Buffer.alloc(64);
    header.write("MZ", 0, "latin1");
    header.writeUInt32LE(signature === "" ? 0 : 64, 60);
    return Buffer.concat([
      header,
      Buffer.from(signature, "latin1"),
      Buffer.alloc(trailing),
    ]);
  };

  it.each([
    ["text", Buffer.from("just some text, not an artifact")],
    ["a DOS MZ image without a Windows header", mzWith("")],
    ["an NE image", mzWith("NE", 60)],
    [
      "an MZ prefix too short to declare anything",
      Buffer.concat([Buffer.from("MZ"), Buffer.alloc(30)]),
    ],
  ])("refuses %s as not LabVIEW, not as an unreadable PE", async (_, bytes) => {
    const message = await refusalMessage("input.bin", bytes);
    expect(message).toContain("not a LabVIEW RSRC container");
    expect(message).not.toContain("could not be read");
  });

  it("reports a declared PE that cannot be admitted as unexamined", async () => {
    // "PE\0\0" at e_lfanew followed by a truncated COFF header.
    const message = await refusalMessage("broken.exe", mzWith("PE\0\0", 4));
    expect(message).toContain("could not be read");
  });

  it("rejects a section-start table that overlaps the block headers", () => {
    const container = buildLabviewRsrc([
      { ident: "vers", sections: [labviewVersionSection()] },
    ]);
    // RSRC header +16 locates the info section; info +44 holds the
    // block-info offset, and its first block header's +8 the table offset.
    const info = container.readUInt32BE(16);
    const blockInfo = info + container.readUInt32BE(info + 44);
    container.writeUInt32BE(0, blockInfo + 4 + 8);
    const parsed = parseLabviewRsrc(container);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure.kind).toBe("malformed");
    expect(parsed.failure.message).toContain("overlaps the block headers");
  });

  it("reports an embedded container's parse failure in file coordinates", async () => {
    // Point the first block's section-start table at the count word, a
    // malformed table reported at that block header's table-offset field.
    const container = labviewContainer();
    const info = container.readUInt32BE(16);
    const blockInfo = info + container.readUInt32BE(info + 44);
    const fieldAt = blockInfo + 4 + 8;
    container.writeUInt32BE(0, fieldAt);
    const direct = parseLabviewRsrc(container);
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.failure.failure.offset).toBe(fieldAt);

    const fixture = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: container },
    ]);
    const origin = fixture.bytes.indexOf(container);
    expect(origin).toBeGreaterThan(0);
    const root = await createTestTempDirectory("rea-labview-embedded-fail-");
    const path = join(root, "fixture.exe");
    await writeFile(path, fixture.bytes);
    const provider = new LabviewArtifactProvider();
    try {
      const result = await provider.inspect({ path });
      if (result.ok) throw new Error("expected a parse refusal");
      expect(result.error).toBeInstanceOf(AnalysisTargetFailureError);
      if (!(result.error instanceof AnalysisTargetFailureError))
        throw result.error;
      expect(result.error.failure).toMatchObject({
        kind: "malformed",
        offset: origin + fieldAt,
      });
    } finally {
      await provider.close();
    }
  });

  /** The container's block-info list offset, from its info section. */
  const blockInfoOf = (container: Buffer): number => {
    const info = container.readUInt32BE(16);
    return info + container.readUInt32BE(info + 44);
  };

  it("reports an impossible block count as truncated, not as capacity", () => {
    const container = buildLabviewRsrc([
      { ident: "vers", sections: [labviewVersionSection()] },
    ]);
    // 5000 declared blocks need 60,000 header bytes the list cannot hold.
    container.writeUInt32BE(4999, blockInfoOf(container));
    const parsed = parseLabviewRsrc(container);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure.kind).toBe("truncated");
  });

  it("keeps a fully framed block count over its allowance a capacity refusal", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc(
        Array.from({ length: 4097 }, () => ({
          ident: "DFDS",
          sections: [Buffer.from("x")],
        })),
      ),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure).toMatchObject({
      kind: "limit",
      limit: { name: "labview_rsrc_blocks", maximum: 4096, required: 4097 },
    });
  });

  it("reports an impossible section count as truncated, not as capacity", () => {
    const container = buildLabviewRsrc([
      { ident: "vers", sections: [labviewVersionSection()] },
    ]);
    // The first block header's +4 holds its section count minus one.
    container.writeUInt32BE(4999, blockInfoOf(container) + 4 + 4);
    const parsed = parseLabviewRsrc(container);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure.kind).toBe("truncated");
  });

  it("keeps a fully framed section count over its allowance a capacity refusal", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([
        {
          ident: "DFDS",
          sections: Array.from({ length: 4097 }, () => Buffer.from("x")),
        },
      ]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure).toMatchObject({
      kind: "limit",
      limit: {
        name: "labview_rsrc_sections_per_block",
        maximum: 4096,
        required: 4097,
      },
    });
  });

  it("rejects a data section that starts inside the fixed header", () => {
    const container = buildLabviewRsrc([
      { ident: "DFDS", sections: [Buffer.from("123456789")] },
    ]);
    // Header +24 is the data offset, +28 the data length.
    container.writeUInt32BE(0, 24);
    container.writeUInt32BE(32 + container.readUInt32BE(28), 28);
    const parsed = parseLabviewRsrc(container);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure).toMatchObject({
      kind: "malformed",
      offset: 24,
    });
  });

  it("rejects data and info sections that overlap", () => {
    const container = buildLabviewRsrc([
      { ident: "DFDS", sections: [Buffer.from("123456789")] },
    ]);
    // Point the data range at the info range, as the review probe did.
    container.writeUInt32BE(container.readUInt32BE(16), 24);
    container.writeUInt32BE(container.readUInt32BE(20), 28);
    const parsed = parseLabviewRsrc(container);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.failure).toMatchObject({
      kind: "malformed",
      offset: 24,
    });
    expect(parsed.failure.message).toContain("data and info sections overlap");
  });

  it("keeps the completed file identity on a later parse failure", async () => {
    const root = await createTestTempDirectory("rea-labview-identity-");
    const path = join(root, "fixture.vi");
    const bytes = Buffer.concat([Buffer.from("RSRC\r\n"), Buffer.alloc(10)]);
    await writeFile(path, bytes);
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.partialObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path,
        bytes: bytes.length,
      });
    await provider.close();
  });

  it("keeps failed cleanup with the input-size refusal", () => {
    const path = "/artifact/fixture.vi";
    const cause = new ArtifactReaderFailure(
      "limit",
      "Selected artifact exceeds the input allowance",
      {
        boundary: "file-size",
        cleanup: { reason: "descriptor close failed", resources: [path] },
      },
    );
    const projected = classifyProviderFailure(cause, labviewReadDialect(path));
    expect(projected.cleanupIncomplete).toBe(true);
    expect(projected.cleanupResources).toContain(path);
    const publicView = projectAnalysisError(projected);
    expect(publicView.details).toMatchObject({
      boundary: "file-size",
      truncated: true,
    });
  });

  it("states the input allowance when the size refusal has no pending cleanup", () => {
    const path = "/artifact/fixture.vi";
    const cause = new ArtifactReaderFailure(
      "limit",
      "Selected artifact exceeds the input allowance",
      {
        boundary: "file-size",
      },
    );
    const projected = classifyProviderFailure(cause, labviewReadDialect(path));
    const publicView = projectAnalysisError(projected);
    expect(publicView.details).toMatchObject({ boundary: "file-size" });
    expect(publicView.remediation.action).toContain(
      "256 MiB LabVIEW artifact input allowance",
    );
  });

  it("reports heap presence as unknown when content was not examined", async () => {
    const root = await createTestTempDirectory("rea-labview-unknown-");
    const path = join(root, "fixture.vi");
    await writeFile(
      path,
      buildLabviewRsrc([
        { ident: "vers", sections: [labviewVersionSection()] },
        { ident: "LVzp", sections: [Buffer.from("\x00\x00\x00\x01tree")] },
      ]),
    );
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    // The embedded program tree was inventoried but not decoded, so neither
    // heap can be called absent from the artifact.
    expect(result.value.block_diagram).toBe("unknown");
    expect(result.value.front_panel).toBe("unknown");
    expect(result.value.limitations.join(" ")).toContain(
      "unexamined content could still hold one",
    );
    await provider.close();
  });
});
