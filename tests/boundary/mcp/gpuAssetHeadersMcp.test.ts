import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  ddsBc7Fixture,
  glbFixture,
  ktx2Fixture,
  ktxFixture,
} from "../../../src/artifacts/gpuAsset/gpuAsset.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";

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
    const reply = await call("inspect_artifact", { detail: "summary" });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const summary = z
      .object({
        parent_evidence_id: z.string(),
        summary: z.object({ root_format_metadata: z.unknown() }),
      })
      .parse(parseEvidence(reply.structuredContent).normalized_result);
    expect(summary.summary.root_format_metadata).toMatchObject({
      kind: format,
      extent_check: "consistent",
    });
    const retained = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: summary.parent_evidence_id,
      },
      view: {
        kind: "inventory",
        collection: "occurrences",
        logical_paths: [region],
        fields: ["logical_path", "format_metadata"],
      },
    });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    expect(
      analysisViewResultSchema.parse(
        parseEvidence(retained.structuredContent).normalized_result,
      ),
    ).toMatchObject({
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
