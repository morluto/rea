import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  inspectInventorySummary,
  inspectRetainedOccurrences,
} from "../../fixtures/artifactInventoryMcp.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { dfuseFile } from "../../../src/domain/firmware/dfuse.fixture.js";
import {
  RP2040_FAMILY,
  UF2_FLAGS,
  RP2XXX_ABSOLUTE_FAMILY,
  patternBytes,
  uf2Block,
  uf2File,
  uf2Image,
} from "../../../src/domain/firmware/uf2.fixture.js";

const APP = patternBytes(300, 9);
const REGION = "family-0xe48bff56/0x10000000-0x1000012b.bin";
const ABSOLUTE_REGION = "family-0xe48bff57/0x10ffff00-0x10ffffff.bin";

// The compiled stdio fixture checks advertised schemas against their dialect and
// validates actual tool responses, avoiding a second source server module graph.
it.each(["compact"] as const)(
  "exposes UF2 facts, retained regions and extraction through MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-uf2-mcp-");
    const path = join(root, "firmware.uf2");
    await writeFile(
      path,
      uf2File([
        uf2Block({
          address: 0x10ff_ff00,
          payload: new Uint8Array(256).fill(0xef),
          blockNo: 0,
          numBlocks: 2,
          familyId: RP2XXX_ABSOLUTE_FAMILY,
        }),
        ...uf2Image(RP2040_FAMILY, 0x1000_0000, APP),
      ]),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const summary = await inspectInventorySummary(call);
      expect(summary.summary.root_format_metadata).toMatchObject({
        kind: "uf2",
        family_count: 2,
        missing_block_count: 1,
        region_count: 2,
      });
      expect(summary.summary.source_coverage).toMatchObject({
        status: "unknown",
      });
      expect(summary.limitations).toContainEqual(
        expect.stringMatching(
          /1 block.*absent.*0xe48bff57.*2 numbered blocks.*1/iu,
        ),
      );
      const view = await inspectRetainedOccurrences(
        call,
        summary.parent_evidence_id,
        {
          logical_paths: [REGION, ABSOLUTE_REGION],
          fields: ["logical_path", "format_metadata"],
        },
      );
      expect(view).toMatchObject({
        items: [
          { logical_path: REGION, format_metadata: { family_name: "RP2040" } },
          { logical_path: ABSOLUTE_REGION },
        ],
      });
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(result.containment_verified).toBe(true);
      expect(result.coverage.status).toBe("unknown");
      expect(
        Buffer.compare(await readFile(join(result.output_root, REGION)), APP),
      ).toBe(0);
      expect(
        Buffer.compare(
          await readFile(join(result.output_root, ABSOLUTE_REGION)),
          Buffer.alloc(256, 0xef),
        ),
      ).toBe(0);
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);

it("preserves valid regions while excluding a UF2 payload overlapping MD5 metadata", async () => {
  const root = await createTestTempDirectory("rea-uf2-md5-mcp-");
  const path = join(root, "firmware.uf2");
  const valid = patternBytes(452, 1);
  const plain = patternBytes(476, 2);
  await writeFile(
    path,
    uf2File([
      uf2Block({
        address: 0x1000,
        payload: valid,
        blockNo: 0,
        numBlocks: 3,
        flags: UF2_FLAGS.md5,
      }),
      uf2Block({
        address: 0x2000,
        payload: patternBytes(453, 3),
        blockNo: 1,
        numBlocks: 3,
        flags: UF2_FLAGS.md5,
      }),
      uf2Block({ address: 0x3000, payload: plain, blockNo: 2, numBlocks: 3 }),
    ]),
  );
  const { call } = await connectLocalToolsMcp({});
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const inspected = await call("inspect_artifact", {});
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    expect(inspection.coverage.status).toBe("partial");
    expect(inspection.limitations).toContainEqual(
      expect.stringMatching(/invalid.*block 1.*MD5/iu),
    );
    const extracted = await call("extract_artifact", {});
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(result.coverage.status).toBe("unknown");
    expect(
      Buffer.compare(
        await readFile(join(outputRoot, "no-family/0x00001000-0x000011c3.bin")),
        valid,
      ),
    ).toBe(0);
    expect(
      Buffer.compare(
        await readFile(join(outputRoot, "no-family/0x00003000-0x000031db.bin")),
        plain,
      ),
    ).toBe(0);
    await expect(
      readFile(join(outputRoot, "no-family/0x00002000-0x000021c4.bin")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await call("close_binary", {});
  } finally {
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("delivers a DfuSe CRC contradiction under both integrity policies through MCP", async () => {
  const root = await createTestTempDirectory("rea-dfuse-mcp-");
  const path = join(root, "firmware.dfu");
  const valid = dfuseFile({
    targets: [
      {
        alternateSetting: 0,
        name: "Internal Flash",
        elements: [
          { address: 0x0800_0000, data: [1, 2, 3, 4] },
          { address: 0x0800_4000, data: [5, 6] },
        ],
      },
      {
        alternateSetting: 1,
        elements: [{ address: 0x1fff_c000, data: [0xaa, 0x55] }],
      },
    ],
  });
  const computedCrc = valid.readUInt32LE(valid.length - 4);
  const computedHex = computedCrc.toString(16).padStart(8, "0");
  const corrupt = Buffer.from(valid);
  corrupt.writeUInt32LE(0, corrupt.length - 4);
  await writeFile(path, corrupt);
  const { call } = await connectLocalToolsMcp({});
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const rejected = parseMcpToolError(await call("inspect_artifact", {}));
  expect(rejected.error).toMatchObject({
    code: "artifact_integrity_mismatch",
    details: {
      logical_path: ".",
      algorithm: "dfu-crc32",
      declared_crc32: "00000000",
      calculated_crc32: computedHex,
    },
  });
  const recorded = await call("inspect_artifact", {
    integrity_policy: "record-and-continue",
  });
  expect(recorded.isError, JSON.stringify(recorded)).not.toBe(true);
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(recorded.structuredContent).normalized_result,
  );
  expect(inspection.contradictions).toEqual([
    expect.objectContaining({
      algorithm: "dfu-crc32",
      declared_crc32: "00000000",
    }),
  ]);
  const graph = artifactInventoryResultSchema.parse(
    inspection.substeps[0]?.evidence.normalized_result,
  );
  const rootOccurrence = graph.occurrences.find(
    (row) => row.logical_path === ".",
  );
  expect(rootOccurrence).toMatchObject({
    hash_status: "mismatched",
    limitations: ["Declared integrity metadata contradicts observed bytes."],
    format_metadata: { suffix_crc: 0, computed_crc: computedCrc },
  });
  expect(graph.integrity_contradictions).toEqual([
    expect.objectContaining({
      occurrence_id: rootOccurrence?.occurrence_id,
      logical_path: ".",
      algorithm: "dfu-crc32",
      declared_crc32: "00000000",
      observed_crc32: computedHex,
      trust: "observed-untrusted",
    }),
  ]);
  expect(graph.limitations).toContainEqual(
    expect.stringMatching(/1.*integrity.*observed-untrusted/iu),
  );
  expect(graph.occurrences.map(({ logical_path }) => logical_path)).toEqual([
    ".",
    "target-0/element-0-0x08000000-0x08000003.bin",
    "target-0/element-1-0x08004000-0x08004001.bin",
    "target-1/element-0-0x1fffc000-0x1fffc001.bin",
  ]);
  await call("close_binary", {});
});
