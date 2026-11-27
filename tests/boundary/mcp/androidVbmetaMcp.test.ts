import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import { z } from "zod";

import { androidVbmetaSummaryMetadataSchema } from "../../../src/domain/analysisView/androidVbmetaSummary.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import { DEFAULT_ANDROID_VBMETA_READER_LIMITS } from "../../../src/domain/artifactReaderLimits.js";
import {
  ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
  SAMPLE_PUBLIC_KEY,
  androidVbmetaDescriptorCountOverflow,
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
    const metadata = inventory.occurrences.find(
      (row) => row.logical_path === ".",
    )?.format_metadata;
    if (metadata?.kind !== "android-vbmeta")
      throw new Error("Expected vbmeta root metadata");
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
    for (const [index, descriptor] of metadata.descriptors.entries()) {
      const name = descriptor.tag_name.toLowerCase().replaceAll("_", "-");
      expect(
        (
          await readFile(
            join(outputRoot, `descriptor-${String(index)}-${name}.bin`),
          )
        ).equals(
          bytes.subarray(
            descriptor.offset,
            descriptor.offset + 16 + descriptor.num_bytes_following,
          ),
        ),
      ).toBe(true);
    }
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
        details: {
          operation: "inspect_artifact",
          ...(fixture.kind === "limit"
            ? { reason: "limit" }
            : { failure_kind: fixture.kind, format: "android-vbmeta" }),
        },
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

it("refuses descriptors past the default count and admits them on retry through compiled MCP", async () => {
  const root = await createTestTempDirectory(
    "rea-android-vbmeta-mcp-descriptors-",
  );
  const path = join(root, "vbmeta.img");
  const bytes = androidVbmetaDescriptorCountOverflow();
  await writeFile(path, bytes);
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  try {
    expect((await call("open_binary", { path })).isError).not.toBe(true);
    const { error } = parseMcpToolError(await call("inspect_artifact", {}));
    expect(error).toMatchObject({
      code: "partial",
      retryable: true,
      details: {
        reason: "limit",
        reader_limit: {
          parameter: "artifact_limits.android_vbmeta.descriptor_count",
          effective_value:
            DEFAULT_ANDROID_VBMETA_READER_LIMITS.descriptor_count,
          unit: "count",
          required_value: ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
          can_increase: true,
          update_mode: "parameter",
        },
      },
    });
    const selected = {
      android_vbmeta: { descriptor_count: ANDROID_VBMETA_OVERFLOW_DESCRIPTORS },
    };
    const reply = await call("inspect_artifact", {
      detail: "summary",
      artifact_limits: selected,
    });
    expect(reply.isError, JSON.stringify(reply).slice(0, 2000)).not.toBe(true);
    const summary = z
      .object({
        summary: z.object({ root_format_metadata: z.unknown() }),
      })
      .parse(parseEvidence(reply.structuredContent).normalized_result).summary;
    expect(
      androidVbmetaSummaryMetadataSchema.parse(summary.root_format_metadata),
    ).toMatchObject({
      descriptor_count: ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
      unknown_count: ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
      descriptor_failure: null,
    });
    expect((await readFile(path)).equals(bytes)).toBe(true);
  } finally {
    await call("close_binary", {});
  }
});
