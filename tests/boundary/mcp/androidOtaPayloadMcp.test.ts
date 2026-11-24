import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  analysisViewResultSchema,
  artifactInventorySummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisViewResult.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  fullAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "../../../src/domain/firmware/androidOtaPayload.fixture.js";

it("extracts and retains complete OTA facts behind a compact MCP summary", async () => {
  const root = await createTestTempDirectory("rea-android-ota-mcp-");
  const path = join(root, "payload.bin");
  const bytes = fullAndroidOtaPayload();
  await writeFile(path, bytes);
  const { call } = await connectLocalToolsMcp({});
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  expect(opened.structuredContent).toMatchObject({
    result: {
      kind: "archive",
      format: "android-ota-payload",
      architecture: null,
    },
  });

  const inspected = await call("inspect_artifact", { detail: "summary" });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const { summary, parent_evidence_id } =
    artifactInventorySummaryViewResultSchema.parse(
      parseEvidence(inspected.structuredContent).normalized_result,
    );
  expect(summary).toMatchObject({
    source_coverage: { status: "complete" },
    root_format_metadata: {
      kind: "android-ota-payload-summary",
      payload_kind: "full",
      security_patch_level: "2024-01-05",
      signatures_verified: false,
      partition_count: 2,
      extractable_partition_count: 2,
      dynamic_partition_group_count: 1,
      apex_info_count: 1,
    },
  });
  for (const field of [
    "partitions",
    "dynamic_partition_groups",
    "apex_info",
    "operation_counts",
  ])
    expect(summary.root_format_metadata).not.toHaveProperty(field);

  const extracted = await call("extract_artifact", {
    output_root: join(root, "out"),
  });
  expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
  const result = artifactExtractionResultSchema.parse(
    parseEvidence(extracted.structuredContent).normalized_result,
  );
  expect(result.containment_verified).toBe(true);
  expect(
    (await readFile(join(result.output_root, "boot.img"))).equals(
      Buffer.from("BOOTIMG"),
    ),
  ).toBe(true);
  expect(
    (await readFile(join(result.output_root, "system.img"))).equals(
      Buffer.alloc(8192),
    ),
  ).toBe(true);
  expect((await readFile(path)).equals(bytes)).toBe(true);
  await unlink(path);

  const retained = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: parent_evidence_id },
    view: {
      kind: "inventory",
      collection: "occurrences",
      fields: ["logical_path", "format_metadata", "hash_status"],
    },
  });
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  const view = analysisViewResultSchema.parse(
    parseEvidence(retained.structuredContent).normalized_result,
  );
  expect(view).toMatchObject({
    kind: "inventory",
    items: [
      {
        logical_path: ".",
        format_metadata: {
          kind: "android-ota-payload",
          magic: "CrAU",
          major_version: 2,
          payload_kind: "full",
          signatures_verified: false,
          snapshot_enabled: true,
          vabc_enabled: true,
          partitions: [{ name: "boot" }, { name: "system" }],
          dynamic_partition_groups: [
            { name: "super", partition_names: ["system"] },
          ],
          apex_info: [{ package_name: "com.android.runtime" }],
        },
      },
      {
        logical_path: "boot.img",
        hash_status: "verified",
        format_metadata: { name: "boot", extractable: true },
      },
      { logical_path: "system.img", hash_status: "verified" },
    ],
  });

  await writeFile(path, v1AndroidOtaPayload());
  const { error } = parseMcpToolError(await call("open_binary", { path }));
  expect(error).toMatchObject({
    code: "target_unavailable",
    details: {
      constraint: "file_format_rejected",
      reason: expect.stringContaining("Android OTA payload major version 1"),
    },
  });
});
