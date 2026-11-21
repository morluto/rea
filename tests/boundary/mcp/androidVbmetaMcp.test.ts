import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import { z } from "zod";

import { androidVbmetaSummaryMetadataSchema } from "../../../src/domain/analysisView/androidVbmetaSummary.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import {
  SAMPLE_PUBLIC_KEY,
  androidVbmetaRefusals,
  sampleAndroidVbmeta,
} from "../../../src/domain/firmware/androidVbmeta.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("retains Android vbmeta facts through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-android-vbmeta-mcp-");
  const path = join(root, "vbmeta.img");
  const bytes = sampleAndroidVbmeta();
  await writeFile(path, bytes);
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      result: {
        kind: "archive",
        format: "android-vbmeta",
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
          kind: "android-vbmeta",
          algorithm_name: "SHA256_RSA2048",
          signatures_verified: false,
          public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
        }),
      }),
    );
    const summary = await call("inspect_artifact", { detail: "summary" });
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    // The strict summary schema rejects a retained descriptor array.
    const summaryRoot = androidVbmetaSummaryMetadataSchema.parse(
      z
        .object({ summary: z.object({ root_format_metadata: z.unknown() }) })
        .parse(parseEvidence(summary.structuredContent).normalized_result)
        .summary.root_format_metadata,
    );
    expect(summaryRoot).toMatchObject({
      kind: "android-vbmeta-summary",
      descriptor_count: 6,
      property_count: 1,
      hashtree_count: 1,
      hash_count: 1,
      kernel_cmdline_count: 1,
      chain_partition_count: 1,
      unknown_count: 1,
      descriptor_failure: null,
    });
    const extracted = await call("extract_artifact", {});
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(result.containment_verified).toBe(true);
    expect(sha256Hex(await readFile(join(outputRoot, "public_key")))).toBe(
      sha256Hex(SAMPLE_PUBLIC_KEY),
    );
    expect((await readFile(path)).equals(bytes)).toBe(true);
    await call("close_binary", {});
  } finally {
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("keeps Android vbmeta parser refusal kinds and recovers through compiled MCP", async () => {
  const root = await createTestTempDirectory(
    "rea-android-vbmeta-mcp-refusals-",
  );
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  try {
    for (const fixture of androidVbmetaRefusals()) {
      const path = join(root, `${fixture.name}.img`);
      await writeFile(path, fixture.bytes);
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const { error } = parseMcpToolError(await call("inspect_artifact", {}));
      expect(error, fixture.name).toMatchObject({
        code: fixture.code,
        category: fixture.category,
        details: { operation: "inspect_artifact", reason: fixture.kind },
      });
      expect((await readFile(path)).equals(fixture.bytes)).toBe(true);
      expect((await call("close_binary", {})).isError).not.toBe(true);
    }
    const path = join(root, "valid.img");
    await writeFile(path, sampleAndroidVbmeta());
    expect((await call("open_binary", { path })).isError).not.toBe(true);
    expect((await call("inspect_artifact", {})).isError).not.toBe(true);
  } finally {
    await call("close_binary", {});
  }
});
