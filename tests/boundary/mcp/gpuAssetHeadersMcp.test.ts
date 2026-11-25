import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  inspectInventorySummary,
  inspectRetainedOccurrences,
} from "../../fixtures/artifactInventoryMcp.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  ddsBc7Fixture,
  glbFixture,
  ktx2Fixture,
  ktxFixture,
} from "../../../src/artifacts/gpuAsset/gpuAsset.fixture.js";

it("exposes DDS, GLB, KTX and KTX2 header summaries and region pages through MCP", async () => {
  const root = await createTestTempDirectory("rea-gpu-asset-mcp-");
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  for (const [format, bytes, region, role] of [
    ["dds", ddsBc7Fixture(), "payload.bin", "payload"],
    ["glb", glbFixture(), "images/0.png", "image"],
    ["ktx", ktxFixture(), "levels/0.bin", "level"],
    ["ktx2", ktx2Fixture(), "dfd.bin", "data-format-descriptor"],
  ] as const) {
    const path = join(root, `asset.${format}`);
    await writeFile(path, bytes);
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const summary = await inspectInventorySummary(call);
    expect(summary.summary.root_format_metadata).toMatchObject({
      kind: format,
      extent_check: "consistent",
    });
    const view = await inspectRetainedOccurrences(
      call,
      summary.parent_evidence_id,
      {
        logical_paths: [region],
        fields: ["logical_path", "format_metadata"],
      },
    );
    expect(view).toMatchObject({
      kind: "inventory",
      items: [
        expect.objectContaining({
          logical_path: region,
          format_metadata: expect.objectContaining({
            kind: "gpu-asset-region",
            role,
          }),
        }),
      ],
    });
    await call("close_binary", {});
  }
});
