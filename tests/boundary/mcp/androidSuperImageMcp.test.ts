import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import { androidSuperFixture } from "../../fixtures/androidSuperImage.js";
import { fileLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const mcp = fileLocalToolsMcp({
  REA_MCP_TOOL_FAMILIES: "session,artifact",
  REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
});

it("opens backup geometry, then retains Android super partition provenance through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-android-super-mcp-");
  const path = join(root, "super.img");
  const bytes = androidSuperFixture("raw");
  bytes.fill(0, 4096, 4100);
  bytes[12288 + 6] = 3;
  await writeFile(path, bytes);
  const { call } = mcp;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      result: {
        format: "android-super-image",
        kind: "archive",
        architecture: null,
      },
    });
    const limited = await call("inspect_artifact", {
      artifact_limits: {
        android_super_image: { record_count: 11 },
      },
    });
    expect(parseMcpToolError(limited).error).toMatchObject({
      code: "partial",
      retryable: true,
      details: {
        reader_limit: {
          parameter: "artifact_limits.android_super_image.record_count",
          effective_value: 11,
          required_value: 12,
          can_increase: true,
        },
      },
    });
    const inspected = await call("inspect_artifact", {
      artifact_limits: {
        android_super_image: { record_count: 12 },
      },
    });
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.effective_limits?.android_super_image?.record_count).toBe(
      12,
    );
    expect(inventory.manifest.root_sha256).toBe(sha256Hex(bytes));
    expect(inventory.coverage).toMatchObject({ status: "complete" });
    expect(inventory.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("backup Android super geometry"),
        expect.stringContaining("backup Android super slot 0"),
      ]),
    );
    expect(
      inventory.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "android-super-image",
      geometry_offset: 8192,
      copies: [
        { slot: 0, copy: "backup", metadata_offset: 20480 },
        { slot: 1, copy: "primary", metadata_offset: 16384 },
      ],
    });
    expect(
      inventory.occurrences.find(
        (row) => row.logical_path === "slot-0/system_a",
      ),
    ).toMatchObject({
      source_location: { offset: 20608, length: 52 },
      artifact_id: null,
      format_metadata: {
        extents: [{ record_offset: 20712, image_offset: 32768 }],
      },
    });
    expect(
      parseMcpToolError(await call("extract_artifact", {})).error,
    ).toMatchObject({
      code: "unsupported_target",
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  } finally {
    await call("close_binary", {});
  }
});
