import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../../../src/domain/firmware/androidOtaPayload.fixture.js";

it.each(["compact"] as const)(
  "retains Android OTA payload facts through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-android-ota-mcp-");
    const path = join(root, "payload.bin");
    await writeFile(path, fullAndroidOtaPayload());
    const { call } = await connectLocalToolsMcp({
      REA_MCP_TOOL_FAMILIES: "session,artifact",
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
      REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        result: {
          kind: "archive",
          format: "android-ota-payload",
          architecture: null,
        },
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
          logical_path: ".",
          format_metadata: expect.objectContaining({
            kind: "android-ota-payload",
            payload_kind: "full",
            signatures_verified: false,
            security_patch_level: "2024-01-05",
          }),
        }),
      );
      const summary = await call("inspect_artifact", { detail: "summary" });
      expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
      const summaryRoot = JSON.stringify(
        parseEvidence(summary.structuredContent).normalized_result,
      );
      expect(summaryRoot).toContain('"kind":"android-ota-payload-summary"');
      expect(summaryRoot).not.toContain('"operation_counts"');
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(result.containment_verified).toBe(true);
      expect(
        (await readFile(join(result.output_root, "boot.img")))
          .subarray(0, 7)
          .toString("latin1"),
      ).toBe("BOOTIMG");
    } finally {
      if (outputRoot !== undefined) await rm(outputRoot, { recursive: true });
    }
  },
);

it("refuses a v1 Android OTA payload through compiled MCP open_binary", async () => {
  const root = await createTestTempDirectory("rea-android-ota-mcp-v1-");
  const path = join(root, "payload.bin");
  await writeFile(path, v1AndroidOtaPayload());
  const { call } = await connectLocalToolsMcp({
    REA_MCP_TOOL_FAMILIES: "session,artifact",
  });
  const opened = await call("open_binary", { path });
  expect(opened.isError).toBe(true);
  expect(JSON.stringify(opened)).toContain("unsupported");
});
