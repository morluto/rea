import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  twoVolumeUbiImage,
  UBI_FIXTURE_KERNEL,
} from "../../../src/domain/firmware/ubiImage.fixture.js";

it("retains UBI image facts and extracts volumes through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-ubi-image-mcp-");
  const path = join(root, "nand.ubi");
  await writeFile(path, twoVolumeUbiImage());
  const { call } = await connectLocalToolsMcp(
    {
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      REA_MCP_TOOL_FAMILIES: "session,artifact",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
    },
    undefined,
    { maxBufferSize: 16 * 1024 * 1024 },
  );
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      result: { kind: "archive", format: "ubi-image", architecture: null },
    });
    const reply = await call("inspect_artifact", {});
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.coverage.status).toBe("complete");
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "volumes/rootfs",
        format_metadata: expect.objectContaining({
          kind: "ubi-volume",
          type: "dynamic",
          stale_leb_copy_count: 1,
        }),
      }),
    );
    const summary = await call("inspect_artifact", { detail: "summary" });
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    const summaryRoot = JSON.stringify(
      parseEvidence(summary.structuredContent).normalized_result,
    );
    expect(summaryRoot).toContain('"kind":"ubi-image-summary"');
    expect(summaryRoot).toContain('"volume_count":2');
    const extracted = await call("extract_artifact", {});
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(result.containment_verified).toBe(true);
    expect(
      (await readFile(join(result.output_root, "volumes/kernel"))).equals(
        UBI_FIXTURE_KERNEL,
      ),
    ).toBe(true);
  } finally {
    if (outputRoot !== undefined) await rm(outputRoot, { recursive: true });
  }
});
